#!/usr/bin/env python3
"""单条只读查询执行器 —— 自由形数据问答的 DB 出口。

协议：stdin 一行 JSON `{"sql": "...", "maxRows": 200, "maxCell": 500}`
      stdout 一行 JSON `{"columns": [...], "rows": [[...]], "truncated": bool, "rowCount": n, "ms": n}`
      失败同样在 stdout 给一行 JSON `{"error": "..."}`（照抄 tracking_report.py 的约定：
      什么都不输出会让 Node 侧拿到空串再炸一次，错因彻底丢失）。

为什么复用 Python 而不在 Node 侧加 mysql2：本功能极低频（一两个人、1~2 周一次），
每条查询约 1 秒的进程冷启不可感知，而复用能白拿三样东西 ——
pymysql 的 client_flag 默认 0（多语句本就关闭）、SSDictCursor 流式游标、
以及 tracking_report.py 里已经跑通的连接配置与跳板环境。详见 spec §6.1。

**本脚本不是安全边界的全部**：SQL 校验的主体在 Node 侧 `capabilities/sql-guard.js`。
这里再独立挡一次（见 _assert_readonly），是因为跨进程边界不该单点信任 ——
万一有人日后直接调这个脚本，或 Node 侧校验被绕过，这里还有一道。
"""
import json
import os
import sys
import time
from datetime import date, datetime
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import pymysql
    import pymysql.cursors
except ImportError:
    print(json.dumps({"error": "缺少 pymysql，请先 pip install pymysql"}, ensure_ascii=False), flush=True)
    sys.exit(1)

# 连接配置与会话加固复用同目录的报表脚本 —— 单一来源，改一处两边生效。
# 该模块有 __main__ 守卫，顶层只有常量与函数定义，import 无副作用。
from tracking_report import db_config, prepare_session, QUERY_TIMEOUT_S  # noqa: E402

DEFAULT_MAX_ROWS = 200
DEFAULT_MAX_CELL = 500
# 整体结果字节上限：防一次 SELECT 把 Agent 的上下文撑爆。
# 200 行 × 500 字符已经够看趋势，再多对「给人看结论」没有增量价值。
MAX_TOTAL_BYTES = 200_000


def _assert_readonly(sql: str):
    """跨进程边界的第二道只读闸（主闸在 Node 侧 sql-guard.js）。

    这里刻意只做最粗的判定 —— 精细校验重复实现两份必然分叉，
    而「必须 SELECT/WITH 开头」这一条足够挡住直接调用本脚本写数据的情形。
    """
    head = sql.lstrip().lstrip("(").lstrip()[:8].upper()
    if not (head.startswith("SELECT") or head.startswith("WITH")):
        raise ValueError("只允许 SELECT / WITH 开头的只读查询")
    if ";" in sql.rstrip().rstrip(";"):
        raise ValueError("一次只能执行一条语句")


def _jsonable(v, max_cell: int):
    """把驱动返回的值转成能 JSON 序列化的形态，并按需截断。

    Decimal→float 会丢精度，但这里的消费者是「给人看的统计结论」，
    float 的精度足够；转 str 反而会让模型难以比较大小。
    """
    if v is None:
        return None
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        v = v.decode("utf-8", errors="replace")
    if isinstance(v, (int, float, bool)):
        return v
    s = str(v)
    return s if len(s) <= max_cell else s[:max_cell] + "…(已截断)"


def run(payload):
    sql = str(payload.get("sql") or "").strip()
    if not sql:
        raise ValueError("sql 不能为空")
    _assert_readonly(sql)

    max_rows = int(payload.get("maxRows") or DEFAULT_MAX_ROWS)
    max_cell = int(payload.get("maxCell") or DEFAULT_MAX_CELL)

    cfg = db_config()
    # 流式游标：fetchmany(N+1) 取到 N+1 行即判定被截断，不把整个结果集拉进内存。
    # 这是行数上限的实现方式 —— 刻意**不改写 SQL 去加 LIMIT**：要正确识别「顶层」LIMIT
    # 得处理 CTE / UNION / 子查询，而包一层 `SELECT * FROM (...) t LIMIT n` 会在
    # 重名列和 CTE 上直接报错。读到就停是硬保证，零解析风险（详见 spec §3 第 2 层末尾）。
    cfg["cursorclass"] = pymysql.cursors.SSDictCursor

    t0 = time.time()
    conn = pymysql.connect(**cfg)
    try:
        with conn.cursor() as cur:
            prepare_session(cur)  # 时区 +08:00 + MAX_EXECUTION_TIME
            # 事务级只读：即便前面所有校验都被绕过，服务端也会拒绝写。
            # 这是四层防线里唯一由 MySQL 自己执行的一层。
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute(sql)

            columns = [d[0] for d in (cur.description or [])]
            batch = cur.fetchmany(max_rows + 1)
            truncated = len(batch) > max_rows
            batch = batch[:max_rows]

            rows = []
            total = 0
            for r in batch:
                row = [_jsonable(r.get(c), max_cell) for c in columns]
                total += len(json.dumps(row, ensure_ascii=False))
                if total > MAX_TOTAL_BYTES:
                    truncated = True
                    break
                rows.append(row)

            return {
                "columns": columns,
                "rows": rows,
                "rowCount": len(rows),
                "truncated": truncated,
                "ms": int((time.time() - t0) * 1000),
            }
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        print(json.dumps(run(payload), ensure_ascii=False), flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        # 失败也必须给 stdout 一行合法 JSON（同 tracking_report.py 的约定）。
        # 连接类错误单独标注，让上层能回「跳板隧道可能没起」而不是一句含糊的失败。
        msg = f"{type(e).__name__}: {e}"
        # 三分而不是二分：「没配置」「连不上」「查询本身错」的排查方向两两不同。
        # db_config() 缺环境变量时抛 RuntimeError —— 那既不是网络问题也不是 SQL 问题，
        # 报成后两者之一会让人往完全错误的方向查（实测踩过：打包版没加载 .env，
        # 表现为功能坏而机器人正常，一路查到跳板隧道去了）。
        if isinstance(e, RuntimeError) and "环境变量" in str(e):
            kind = "config"
        elif isinstance(e, pymysql.err.OperationalError):
            kind = "connect"
        else:
            kind = "query"
        print(json.dumps({"error": msg, "kind": kind}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())

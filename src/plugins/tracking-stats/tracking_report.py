#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
埋点统计报告生成器。

输入：--spec <QuerySpec JSON 文件路径>
输出：stdout 一行 JSON {"htmlPath": ..., "summary": {...}}；失败输出 {"error": ...} 并退出码 1

约定（对齐 scripts/get_qrcode.py:92）：过程日志一律走 stderr，stdout 只留最终结果。
调用方（Node 侧）只解析 stdout，混进一行日志就会让 JSON.parse 直接炸掉。

口径全部对齐 compass-agent 现有报表（repository/mysql/statistics_data_repository.py），不自创：
机器人给的数与后台报表对不上，信任崩塌一次就很难挽回。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pymysql

# 让 Windows 控制台以 UTF-8 输出中文，避免 GBK 编码错误直接把进程打挂
# （报告标题、事件中文名全是中文，这里不设置必炸）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BEIJING = timezone(timedelta(hours=8))

# 单次查询超时（秒）—— 生产库是共享资源，宁可失败也不能把它拖住
QUERY_TIMEOUT_S = 30
# 结果集行数上限
ROW_LIMIT = 50000

# 排除微信开发者工具：与 StatisticsDataRepository.EXCLUDE_DEVTOOLS 逐字符一致。
# 抽成常量是为了让「口径是否对齐」可以一眼比对，而不是散落在两段 SQL 里各写一遍。
EXCLUDE_DEVTOOLS = "AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$.\"$os\"')) != 'devtools'"

# 事件名 / 页面路径在 properties 里的取值表达式。抽出来是因为它们要在
# 「分维度查询」和「跨维度精确 UV 查询」两处出现，写两遍必然某天只改一处。
EXPR_EVENT_NAME = "JSON_UNQUOTE(JSON_EXTRACT(properties, '$.event_name'))"
EXPR_URL_PATH = "JSON_UNQUOTE(JSON_EXTRACT(properties, '$.\"$url_path\"'))"

# 多序列折线的配色：取自 Okabe-Ito 色觉友好调色板并整体降了一档饱和度。
#
# 为什么不用「红/绿/蓝」这种直觉配色：红绿色盲约占男性 8%，红绿两条线对他们就是同一条。
# 这里每相邻两色既拉开色相、又拉开明度 —— 即便被打印成灰度或被色觉障碍者看到，
# 仍能靠深浅区分。顺序也刻意深浅交替，避免前两条线明度接近。
SERIES_COLORS = ["#1f6f9e", "#d08c2e", "#2e8b74", "#a3628f", "#7fb3d5"]

# 超过这个数量就退回「汇总单线」：再多条折线会互相穿插糊成一团，
# 反而比一条汇总线更看不出趋势。
MULTI_SERIES_MAX = 5


def log(msg):
    """过程日志走 stderr"""
    print(msg, file=sys.stderr, flush=True)


def db_config():
    """数据库配置全部走环境变量。

    不硬编码密码：compass-agent 的 scripts/user_path_analyzer.py:31-37 把生产库密码写死在
    源码里，那是个已存在的安全问题，这里不复制它。
    """
    missing = [
        k for k in ("TRACKING_DB_HOST", "TRACKING_DB_USER", "TRACKING_DB_PASSWORD")
        if not os.environ.get(k)
    ]
    if missing:
        raise RuntimeError(f"缺少环境变量：{', '.join(missing)}")
    return dict(
        host=os.environ["TRACKING_DB_HOST"],
        port=int(os.environ.get("TRACKING_DB_PORT", "3306")),
        database=os.environ.get("TRACKING_DB_NAME", "compass_prod"),
        user=os.environ["TRACKING_DB_USER"],
        password=os.environ["TRACKING_DB_PASSWORD"],
        charset="utf8mb4",
        connect_timeout=10,
        read_timeout=QUERY_TIMEOUT_S + 5,
        cursorclass=pymysql.cursors.DictCursor,
    )


def day_bounds_ms(start_day: str, end_day: str):
    """'YYYY-MM-DD' 起止 → 北京时区的毫秒时间戳区间 [start 00:00, end 次日 00:00)"""
    s = datetime.strptime(start_day, "%Y-%m-%d").replace(tzinfo=BEIJING)
    e = datetime.strptime(end_day, "%Y-%m-%d").replace(tzinfo=BEIJING) + timedelta(days=1)
    return int(s.timestamp() * 1000), int(e.timestamp() * 1000)


def day_axis(start_day: str, end_day: str):
    """区间内**每一天**的日期列表（含首尾）。

    折线的横轴必须是完整日期序列，不能只用「查到数据的那些天」：
    零上报的日子被整天跳过后，横轴就不再等距 —— 中间断了三天会被画成一段普通线段，
    读者看到的是「平稳过渡」，真相是「三天没人用」。
    还有个更隐蔽的后果：末日若无数据，序列的最后一点就不是今天，
    「当日未完」的虚线与空心点会被错标到前一天上去（实测 08-19 无量时标在了 08-18）。
    """
    d = datetime.strptime(start_day, "%Y-%m-%d")
    e = datetime.strptime(end_day, "%Y-%m-%d")
    out = []
    while d <= e:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out


def prev_range_days(start_day: str, end_day: str):
    """上一等长周期的起止日期（'YYYY-MM-DD'）。

    必须与 SQL 侧的环比窗口同源：那边查的是 [start_ms - span, start_ms)，span 恰是本期天数。
    两处各算各的，报告上写的日期迟早会和实际查的窗口悄悄错开一天，且没人能发现。

    为什么要把这两个日期显示出来：
    1) 「较上一周期 ↑188.6%」不写区间，拿去开会必被问「上一周期是哪几天」；
    2) 上期区间整段落在数据保留期外时，「上一周期无数据」会被误读成「那阵子真没人用」。
       把日期摆出来，用户自己就能看出那是不是超出了保留期 ——
       保留期常量在 Node 侧（logic.js 的 RETENTION_DAYS），Python 里再写一份必然分叉。
    """
    s = datetime.strptime(start_day, "%Y-%m-%d")
    e = datetime.strptime(end_day, "%Y-%m-%d")
    span = (e - s).days + 1
    return (s - timedelta(days=span)).strftime("%Y-%m-%d"), (s - timedelta(days=1)).strftime("%Y-%m-%d")


def prepare_session(cur):
    """会话级设置：时区固定 +08:00，单条 SELECT 超时 30 秒。

    时区必须显式钉死。库里 time 是毫秒时间戳，FROM_UNIXTIME 按**会话时区**还原，
    实测生产库 @@session.time_zone = '+08:00'（SYSTEM = Asia/Shanghai），所以
    DATE(FROM_UNIXTIME(time/1000)) 直接就是北京日期 —— compass-agent 全部现有报表都这么写。

    ⚠️ 不能再套一层 CONVERT_TZ(...,'+00:00','+08:00')：那是把已经是北京时间的值**再加 8 小时**，
    实测 epoch 1755604800（北京 20:00）会被分到次日。总量不受影响（WHERE 卡的是毫秒戳），
    但每日趋势整体错位 8 小时，与后台报表对不上 —— 属于「图看着正常、数就是不对」的故障。

    显式 SET 而不是依赖服务端默认：默认值改了这里要能不受影响。
    """
    cur.execute("SET SESSION time_zone = '+08:00'")
    cur.execute(f"SET SESSION MAX_EXECUTION_TIME={QUERY_TIMEOUT_S * 1000}")


def fetch_internal_uids(cur):
    """内测用户名单从 internal_user 表实时读，不硬编码 —— 名单会变，硬编码必然过期。

    条件 is_deleted=0 与 compass-agent 各报表脚本一致（如 deploy/scripts/antisugar_report.py:146）。
    返回**排序后的列表**：SQL 占位符个数与绑定值顺序必须严格对应，用 set 会因迭代顺序
    不稳定而埋下隐患。

    表不存在或查询失败时返回空列表并告警：排除名单缺失会让数字偏高，
    但比整个报告生成失败要好，且脚注里会写明「未排除」。
    """
    try:
        cur.execute("SELECT uid FROM internal_user WHERE is_deleted = 0")
        return sorted({str(r["uid"]) for r in cur.fetchall() if r.get("uid")}), True
    except Exception as e:  # noqa: BLE001
        log(f"⚠️ 内测名单读取失败，本次不排除内测用户：{e}")
        return [], False


def _day_col(group_by_day):
    """分桶列：按天则取北京日期，否则用常量占位（让上层聚合逻辑不必分叉）"""
    return "DATE(FROM_UNIXTIME(time/1000))" if group_by_day else "'ALL'"


def build_event_sql(events, excl_uids, group_by_day):
    """事件维度 SQL。

    - 业务事件名在 properties.event_name，**不是 event 字段**：绝大多数业务埋点的 event
      统一是 '$MPClick'，按 event 查业务事件会一无所获。
    - 排除微信开发者工具、排除内测用户、is_deleted = 0，口径对齐后台报表。

    所有值走占位符绑定：事件名虽已在 Node 侧过了白名单校验，仍不拼串（双保险）。
    只有分桶列和占位符个数是拼进去的，二者都不含外部输入。
    """
    ev_ph = ", ".join(["%s"] * len(events))
    sql = f"""
        SELECT {_day_col(group_by_day)} AS d,
               {EXPR_EVENT_NAME} AS k,
               COUNT(*) AS pv,
               COUNT(DISTINCT distinct_id) AS uv
        FROM statistics_data
        WHERE time >= %s AND time < %s
          AND is_deleted = 0
          AND {EXPR_EVENT_NAME} IN ({ev_ph})
          {EXCLUDE_DEVTOOLS}
    """
    if excl_uids:
        uid_ph = ", ".join(["%s"] * len(excl_uids))
        sql += f"  AND distinct_id NOT IN ({uid_ph})\n"
    sql += f"        GROUP BY d, k LIMIT {ROW_LIMIT}"
    return sql


def build_page_sql(pages, excl_uids, group_by_day):
    """页面维度 SQL：页面访问走 $MPViewScreen + properties.$url_path

    传入的 path 必须是**库内原始值（带前导斜杠）**，即索引快照里的 pages[].path。
    快照里另有个 key 字段是去掉前导斜杠的归一化形式，那个只用于跟中文名字典比对，
    绝不能拿来查库 —— 实测字典 key 无斜杠、库内有，用错了是 0 命中且不报错，
    安静返回空表、报告照常生成并写「该时段无数据」，是最难发现的一类故障。
    """
    pg_ph = ", ".join(["%s"] * len(pages))
    sql = f"""
        SELECT {_day_col(group_by_day)} AS d,
               {EXPR_URL_PATH} AS k,
               COUNT(*) AS pv,
               COUNT(DISTINCT distinct_id) AS uv
        FROM statistics_data
        WHERE time >= %s AND time < %s
          AND is_deleted = 0
          AND event = '$MPViewScreen'
          AND {EXPR_URL_PATH} IN ({pg_ph})
          {EXCLUDE_DEVTOOLS}
    """
    if excl_uids:
        uid_ph = ", ".join(["%s"] * len(excl_uids))
        sql += f"  AND distinct_id NOT IN ({uid_ph})\n"
    sql += f"        GROUP BY d, k LIMIT {ROW_LIMIT}"
    return sql


def query_rows(cur, sql, start_ms, end_ms, keys, excl_uids):
    """绑定顺序必须与 SQL 里占位符出现顺序完全一致：时间区间 → 事件/页面标识 → 内测 uid"""
    cur.execute(sql, [start_ms, end_ms, *keys, *excl_uids])
    return cur.fetchall()


def _spec_keys(spec):
    """从 spec 取出两个维度的查询键；空列表表示该维度不查"""
    events = [e["name"] for e in (spec.get("events") or [])]
    pages = [p["path"] for p in (spec.get("pages") or [])]
    return events, pages


def exact_uv(cur, events, pages, excl_uids, start_ms, end_ms):
    """跨事件与页面的**精确**去重用户数：一条 COUNT(DISTINCT) 覆盖全部标识。

    为什么必须单独查，而不是把各项 UV 取最大值当下界：
    「下界估计」在一份要拿去开会的报告上就是一个星号，读者第一反应是「那这数到底能不能用」。
    而且这个下界的误差远不是恒定的小量 —— 实测（2026-08-19）：

        30 天 6 项（会话+页面）  下界 3,721 / 精确 3,726  低估 0.13%
        30 天 8 项（会话链路）    下界 3,718 / 精确 3,752  低估 0.91%
        14 天 4 项（分享子事件）  下界   165 / 精确   214  低估 22.90%

    最后一行才是关键：各项用户重合度越低，下界越离谱。而「某功能的几个子事件」
    恰恰就是重合度最低的形态，也正是用户最常问的那种问题（「分享功能怎么样」）。
    单次查询实测 0.2~0.8 秒 —— 花不到一秒换掉一个免责声明外加一个可能偏低两成的数字。

    两个维度用 OR 拼在一个 WHERE 里而不是查两次再相加：同一个用户既点了按钮又访问了页面时，
    两次结果相加会把他算成两个人 —— 这正是要消除的重复计数。
    """
    if not events and not pages:
        return 0
    conds, binds = [], [start_ms, end_ms]
    if events:
        conds.append(f"{EXPR_EVENT_NAME} IN ({', '.join(['%s'] * len(events))})")
        binds.extend(events)
    if pages:
        conds.append(
            f"(event = '$MPViewScreen' AND {EXPR_URL_PATH} IN ({', '.join(['%s'] * len(pages))}))"
        )
        binds.extend(pages)
    sql = f"""
        SELECT COUNT(DISTINCT distinct_id) AS uv
        FROM statistics_data
        WHERE time >= %s AND time < %s
          AND is_deleted = 0
          AND ({' OR '.join(conds)})
          {EXCLUDE_DEVTOOLS}
    """
    if excl_uids:
        sql += f"  AND distinct_id NOT IN ({', '.join(['%s'] * len(excl_uids))})\n"
        binds.extend(excl_uids)
    cur.execute(sql, binds)
    row = cur.fetchone()
    return int(row["uv"]) if row else 0


def _sum_pv_by_dim(cur, spec, start_ms, end_ms, excl):
    """某个时间窗内**分维度**的量（不分桶）—— 环比用，返回 (事件次数, 页面浏览量)。

    不相加：点击次数与页面浏览量不是同一量纲，把两者之和拿去算环比，得到的百分比
    既不是「功能被用得更多了」也不是「页面被看得更多了」，且涨跌无法归因到哪个维度。
    未查询的维度返回 None 而不是 0 —— 「没查这个维度」和「上期该维度真的是 0 次」
    在渲染上要给出完全不同的话术。
    """
    events, pages = _spec_keys(spec)
    ev_pv = pg_pv = None
    if events:
        sql = build_event_sql(events, excl, False)
        ev_pv = sum(int(r["pv"]) for r in query_rows(cur, sql, start_ms, end_ms, events, excl))
    if pages:
        sql = build_page_sql(pages, excl, False)
        pg_pv = sum(int(r["pv"]) for r in query_rows(cur, sql, start_ms, end_ms, pages, excl))
    return ev_pv, pg_pv


def run_query(spec):
    """执行查询，返回 {rows, uvByKey, totalUv, eventUv, pageUv, prev, excludedInternal, internalOk}"""
    cfg = db_config()
    start_ms, end_ms = day_bounds_ms(spec["range"]["start"], spec["range"]["end"])
    group_by_day = spec.get("groupBy") == "day"
    events, pages = _spec_keys(spec)

    conn = pymysql.connect(**cfg)
    try:
        with conn.cursor() as cur:
            prepare_session(cur)
            excl, internal_ok = fetch_internal_uids(cur)
            log(f"内测用户名单 {len(excl)} 个")

            rows = []
            if events:
                sql = build_event_sql(events, excl, group_by_day)
                for r in query_rows(cur, sql, start_ms, end_ms, events, excl):
                    rows.append({**r, "kind": "event"})
                log(f"事件维度查得 {len(rows)} 行")

            if pages:
                sql = build_page_sql(pages, excl, group_by_day)
                n0 = len(rows)
                for r in query_rows(cur, sql, start_ms, end_ms, pages, excl):
                    rows.append({**r, "kind": "page"})
                log(f"页面维度查得 {len(rows) - n0} 行")

            # 整段区间内每个标识的**精确**去重用户数。
            #
            # 为什么要多跑一次而不是把上面按天的 uv 加起来：COUNT(DISTINCT) 不可跨桶累加 ——
            # 同一个人连续 7 天都用，会被算成 7 个人。实测 30 天区间聚合值比真实值高 52%
            # （6951 vs 4561）。这种「看着合理、其实虚高一半」的数字比报错危险得多，
            # 而且与后台报表直接对不上。额外一次查询实测 ~0.9s，值得。
            uv_by_key = {}
            if group_by_day:
                if events:
                    sql = build_event_sql(events, excl, False)
                    for r in query_rows(cur, sql, start_ms, end_ms, events, excl):
                        uv_by_key[r["k"]] = int(r["uv"])
                if pages:
                    sql = build_page_sql(pages, excl, False)
                    for r in query_rows(cur, sql, start_ms, end_ms, pages, excl):
                        uv_by_key[r["k"]] = int(r["uv"])
            else:
                # 未分桶时每个标识只有一行，本身就是精确值，不必再查
                for r in rows:
                    uv_by_key[r["k"]] = int(r["uv"])

            # 跨维度的精确去重用户数（总计 + 两张明细表各自的小计）。
            #
            # 只有事件或只有页面时，「小计」与「总计」是同一个集合，直接复用，不多跑一次查询：
            # 单维度是绝大多数场景，为一个必然相等的数字多花一秒不值。
            total_uv, event_uv, page_uv = 0, 0, 0
            if rows:  # 一行都没查到时 UV 必为 0，省掉这几次查询
                total_uv = exact_uv(cur, events, pages, excl, start_ms, end_ms)
                if events and pages:
                    event_uv = exact_uv(cur, events, [], excl, start_ms, end_ms)
                    page_uv = exact_uv(cur, [], pages, excl, start_ms, end_ms)
                elif events:
                    event_uv = total_uv
                else:
                    page_uv = total_uv
            log(f"精确去重用户数：总计 {total_uv}（事件 {event_uv} / 页面 {page_uv}）")

            # 环比：上一等长周期的量，按维度分开保存（相加就又混了量纲）
            prev = None
            if spec.get("compare"):
                span = end_ms - start_ms
                pe, pp = _sum_pv_by_dim(cur, spec, start_ms - span, start_ms, excl)
                prev = {"event": pe, "page": pp}

            return {
                "rows": rows,
                "uvByKey": uv_by_key,
                "totalUv": total_uv,
                "eventUv": event_uv,
                "pageUv": page_uv,
                "prev": prev,
                "excludedInternal": len(excl),
                "internalOk": internal_ok,
            }
    finally:
        conn.close()


# ==================== 聚合与渲染 ====================


def aggregate(rows, spec, uv_by_key):
    """行数据 → 明细汇总 + 每日 PV 汇总序列 + 每项每日 PV 序列 + 总触发次数

    额外产出 series_by_key 是为了多序列折线：用户问「分享功能怎么样」，
    真正想知道的是**哪个子事件在涨**，一条汇总线把这个信息抹平了。
    """
    label_of = {}
    for e in spec.get("events") or []:
        label_of[e["name"]] = e.get("label") or e["name"]
    for p in spec.get("pages") or []:
        label_of[p["path"]] = p.get("label") or p["path"]

    detail = {}
    daily = {}
    daily_by_key = {}
    for r in rows:
        k = r["k"]
        pv = int(r["pv"])
        d = detail.setdefault(
            k, {"key": k, "label": label_of.get(k, k), "kind": r.get("kind", "event"), "pv": 0, "uv": 0}
        )
        d["pv"] += pv  # PV 可以跨天相加
        day = str(r["d"])
        if day != "ALL":
            daily[day] = daily.get(day, 0) + pv
            daily_by_key.setdefault(k, {})[day] = daily_by_key.setdefault(k, {}).get(day, 0) + pv

    for k, d in detail.items():
        d["uv"] = int(uv_by_key.get(k, 0))  # UV 只能取整段区间的精确去重值，绝不跨桶累加

    detail_list = sorted(detail.values(), key=lambda x: -x["pv"])
    total_pv = sum(d["pv"] for d in detail_list)
    # 横轴铺满整个区间并给零上报的日子补 0（见 day_axis 的注释）。
    # rows 为空时不铺：一条贴着 0 的水平线远不如「该时段无数据」四个字说得清楚。
    series = (
        [{"day": d, "pv": daily.get(d, 0)} for d in day_axis(spec["range"]["start"], spec["range"]["end"])]
        if rows and spec.get("groupBy") == "day"
        else []
    )
    # 序列顺序跟明细一致（按总量降序）：图例第一条就是最主要的那项，颜色分配也随之稳定
    series_by_key = [
        {"key": d["key"], "label": d["label"], "daily": daily_by_key.get(d["key"], {})}
        for d in detail_list
        if d["key"] in daily_by_key
    ]
    return detail_list, series, series_by_key, total_pv


def split_dimension(detail, spec):
    """按维度拆分总量，并判定这份报告的维度形态。

    返回 (dimension, event_pv, page_pv, has_events, has_pages)，
    dimension ∈ {'event', 'page', 'both'}。

    为什么以 detail（实查到的行）为准而不是 spec：spec 里选了页面但页面一条没查到时，
    报告上根本不会出现页面表，KPI 再摆一个「页面浏览量 0」只会让人以为哪里漏了。
    两个维度都空（整段无数据）时才回退到 spec —— 那种情况下至少要说清这份报告在统计什么。
    """
    event_pv = sum(d["pv"] for d in detail if d["kind"] == "event")
    page_pv = sum(d["pv"] for d in detail if d["kind"] == "page")
    has_events = any(d["kind"] == "event" for d in detail)
    has_pages = any(d["kind"] == "page" for d in detail)
    if not has_events and not has_pages:
        ev_keys, pg_keys = _spec_keys(spec)
        has_events, has_pages = bool(ev_keys), bool(pg_keys)
        # 两边都没有（理论上 Node 侧的 validateSelection 已挡住）时按事件口径兜底，
        # 免得后面的分支拿不到 dimension
        if not has_events and not has_pages:
            has_events = True
    dimension = "both" if (has_events and has_pages) else ("page" if has_pages else "event")
    return dimension, event_pv, page_pv, has_events, has_pages


def chart_lines(series, series_by_key):
    """决定画「多序列」还是「汇总单线」，返回 ([(名称, 颜色, [每日值...])], 日期列表)。

    2~5 项走多序列：用户问某个功能怎么样，想看的是哪个子项在动，汇总线把这个抹平了。
    1 项时汇总线就等于它自己；超过 5 项时多条线会互相穿插糊成一团，都退回单线。
    """
    days = [s["day"] for s in series]
    if 2 <= len(series_by_key) <= MULTI_SERIES_MAX:
        return [
            (
                s["label"],
                SERIES_COLORS[i % len(SERIES_COLORS)],
                [s["daily"].get(d, 0) for d in days],
            )
            for i, s in enumerate(series_by_key)
        ], days
    return [("", SERIES_COLORS[0], [s["pv"] for s in series])], days


def nice_max(v):
    """把纵轴上界抬到一个「一眼读得出量级」的整数。

    直接拿真实峰值当上界会印出「5,978 / 2,989 / 0」这种刻度，读者得先在心里换算
    才知道这图大概到六千 —— 一张给人扫一眼的趋势图不该有这种摩擦。
    顺带让折线不贴顶，峰值点不会被裁在边框上。
    """
    if v <= 0:
        return 1
    exp = 0
    x = float(v)
    while x >= 10:
        x /= 10
        exp += 1
    while x < 1:
        x *= 10
        exp -= 1
    for m in (1, 1.5, 2, 3, 4, 5, 6, 8, 10):
        if x <= m:
            return max(1, int(round(m * (10 ** exp))))
    return max(1, int(round(10 * (10 ** exp))))


def _svg_path(pts):
    return " ".join(f"{'M' if i == 0 else 'L'}{x:.1f},{y:.1f}" for i, (x, y) in enumerate(pts))


def svg_line_chart(lines, days, incomplete_last=False, width=720, height=260):
    """手写内联 SVG 折线图。

    不引 ECharts / CDN：报告是离线附件，引外链在断网或内网环境下变成一堆空白框；
    引库则让附件膨胀到 1MB 以上。数据量小（最多 90 个点），折线足够。

    incomplete_last=True 时把最后一天画成「未完成」而不是一个正常数据点。
    这条不是装饰：30 天图里今天从 3098 掉到 28，视觉上就是一条垂直坠落，
    读者的第一反应是「出事故了」。脚注里写了「截至 12:49」没用 —— 没人先看脚注。
    虚线 + 空心点 + 顶部竖向标注三重冗余，是为了不看脚注也能明白那不是暴跌。

    字号不写死在属性里而是走 CSS 类（.cx/.cy/.cn）：SVG 靠 viewBox 等比缩放，
    在飞书里用手机点开时整张图被缩到一半，写死 10px 就只剩 5px 完全看不清。
    用类名才能配合页面里的 @media 在窄屏上把字号顶上去。
    """
    if not days:
        return '<p class="empty">该时段无数据</p>'
    # 纵轴刻度写在网格线**上方、图内左侧**，而不是挤在左边的留白里。
    # 靠左留白放刻度的老写法有个死结：窄屏上字号必须放大（否则看不清），
    # 但留白宽度是 viewBox 里的固定值，跟着一起缩小 —— 结果就是「6,000」被裁成「,000」。
    # 放进图内就与字号彻底解耦，顺带把左边那块留白还给了折线。
    pad_l, pad_r, pad_t, pad_b = 16, 16, 34, 34
    w, h = width, height
    plot_w, plot_h = w - pad_l - pad_r, h - pad_t - pad_b
    max_pv = nice_max(max((max(vals) for _, _, vals in lines if vals), default=0))
    n = len(days)
    step = plot_w / (n - 1) if n > 1 else 0

    def x_at(i):
        return pad_l + i * step if n > 1 else pad_l + plot_w / 2

    def y_at(v):
        return pad_t + plot_h * (1 - v / max_pv)

    # paint-order + 白描边给刻度加一圈底衬：刻度压在图内，不这样处理会和折线糊在一起
    grid = "".join(
        f'<line x1="{pad_l}" y1="{pad_t + plot_h * f:.1f}" x2="{w - pad_r}" '
        f'y2="{pad_t + plot_h * f:.1f}" stroke="#e5e7eb" stroke-width="1"/>'
        f'<text class="cy" x="{pad_l + 2}" y="{pad_t + plot_h * f - 6:.1f}" fill="#9ca3af" '
        f'text-anchor="start" stroke="#ffffff" stroke-width="3" paint-order="stroke">'
        f'{int(round(max_pv * (1 - f))):,}</text>'
        for f in (0, 0.5, 1)
    )

    # 「今日未完」竖向标记：先画在最底层，免得盖住折线
    marker = ""
    if incomplete_last:
        mx = x_at(n - 1)
        marker = (
            f'<line x1="{mx:.1f}" y1="{pad_t}" x2="{mx:.1f}" y2="{pad_t + plot_h}" '
            f'stroke="#9ca3af" stroke-width="1" stroke-dasharray="3 3"/>'
            f'<text class="cn" x="{mx:.1f}" y="{pad_t - 9}" fill="#6b7280" text-anchor="end">'
            f'当日未完</text>'
        )

    paths, dots = [], []
    # 点太密时不画圆点：90 天区间下 90 个圆点会连成一条粗带，反而看不出折线形状
    show_dots = n <= 45
    for name, color, vals in lines:
        pts = [(x_at(i), y_at(v)) for i, v in enumerate(vals)]
        # 最后一段单独画成虚线半透明：实线到此为止 = 「已完整」的部分到此为止
        solid = pts[:-1] if (incomplete_last and n > 1) else pts
        if len(solid) > 1:
            paths.append(
                f'<path d="{_svg_path(solid)}" fill="none" stroke="{color}" stroke-width="2.5" '
                f'stroke-linejoin="round" stroke-linecap="round"/>'
            )
        if incomplete_last and n > 1:
            paths.append(
                f'<path d="{_svg_path(pts[-2:])}" fill="none" stroke="{color}" stroke-width="2.5" '
                f'stroke-dasharray="5 4" opacity="0.45" stroke-linecap="round"/>'
            )
        prefix = f"{name} · " if name else ""
        for i, (x, y) in enumerate(pts):
            last_incomplete = incomplete_last and i == n - 1
            if not show_dots and not last_incomplete:
                continue
            tip = f'<title>{esc(days[i])} {esc(prefix)}{vals[i]:,}' + (
                "（当日未完）</title>" if last_incomplete else "</title>"
            )
            if last_incomplete:
                # 空心 + 灰边：与实心彩色点形成明确对比，一眼看出「这个点不一样」
                dots.append(
                    f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4.5" fill="#ffffff" stroke="#9ca3af" '
                    f'stroke-width="2">{tip}</circle>'
                )
            else:
                dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}">{tip}</circle>')

    # x 轴标签最多 5 个，且**从最后一天倒着取** —— 保证最后一天必被标注，
    # 否则「今日未完」那个标记指向的是哪天要靠数格子。
    # 上限取 5 不取 6：窄屏上字号被媒体查询顶到 28 用户单位，6 个标签在 90 天区间里
    # 最后两个几乎贴到一起。
    stride = max(1, -(-n // 5))
    idxs = sorted(set(range(n - 1, -1, -stride)))
    # 首尾两个标签改用 start/end 对齐：居中对齐会让它们各有一半探出画布被裁掉，
    # 而最后一天恰恰是最需要看清的那个（「当日未完」指的就是它）
    labels = "".join(
        f'<text class="cx" x="{x_at(i):.1f}" y="{h - 10}" fill="#6b7280" '
        f'text-anchor="{"start" if i == 0 else "end" if i == n - 1 else "middle"}">'
        f'{esc(str(days[i])[5:])}</text>'
        for i in idxs
    )

    return (
        f'<svg class="chart" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img">'
        f'{grid}{marker}{"".join(paths)}{"".join(dots)}{labels}</svg>'
    )


def legend_html(lines):
    """多序列时的图例。用 HTML 而不是画进 SVG：
    HTML 能随容器宽度自动换行、字号直接受页面 CSS 控制，手机上不会被 viewBox 一起缩小。
    """
    if len(lines) < 2:
        return ""
    items = "".join(
        f'<span class="lg"><i style="background:{c}"></i>{esc(name)}</span>' for name, c, _ in lines
    )
    return f'<div class="legend">{items}</div>'


def esc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def build_notes(
    spec, excluded_internal, internal_ok, has_events, has_pages, avg_days, has_chart, total_uv=None
):
    """口径脚注。

    脚注是必需品不是装饰：数据报告最大的风险是拿去开会的人不知道口径，
    为一个「对不上的数字」争论半天。排除规则、时间范围、生成时刻必须写在文件里。
    """
    notes = [
        "已排除微信开发者工具（$os = devtools）产生的数据",
    ]
    if internal_ok:
        notes.append(f"已排除内测用户 {excluded_internal} 个（来自 internal_user 表，实时读取）")
    else:
        # 名单没读到就必须说，否则数字偏高而无人知晓
        notes.append("⚠️ 内测用户名单读取失败，本次未排除内测用户，数字偏高")
    notes.append("时间按北京时区（UTC+8）分桶，与后台报表一致")
    # 脚注是纯 HTML 文本，不经 Markdown 渲染 —— 写 **强调** 只会把星号原样印在报告上
    notes.append("「用户数」均为整个区间内的去重用户数（精确值，非每日或各项相加）")
    if has_events and has_pages:
        # 曾经这里写的是「顶部总触发次数为两者相加」—— 那个相加出来的数是苹果加橘子，
        # 既不能回答「功能被用了多少次」也不能回答「页面被看了多少次」。现在 KPI、日均、
        # 环比全部按维度分开，脚注也改成说明「不相加」，免得读者反过来自己去加。
        notes.append("事件与页面口径不同（点击次数 vs 页面浏览量），已拆成两张表各自计算占比；顶部 KPI、用户数、日均与环比也按维度分开呈现，不做相加")
        if isinstance(total_uv, int):
            # 顶部给的是两个分维度用户数，相加会把「既点按钮又看页面」的人算两遍。
            # 全局去重值只有这一处能看到，不写出来就等于把它从报告里删了。
            notes.append(f"顶部两个用户数分属两个维度，不可相加；整个区间跨维度去重的用户数为 {total_uv:,} 人")

    if spec.get("includesToday"):
        # 「图中最后一段为虚线」只在真画了趋势图时才说 —— 单日查询和零数据都没有图，
        # 让读者回头去找一条不存在的虚线，比不写这句更糟
        chart_hint = "（图中最后一段为虚线）" if has_chart else ""
        notes.append(f"今日数据截至 {datetime.now(BEIJING).strftime('%H:%M')}，尚不完整{chart_hint}")
        if avg_days:
            notes.append(f"日均按已走完的 {avg_days} 天计算，不含尚未走完的今天")
        if spec.get("compare"):
            # 当期含未走完的今天、上期是完整周期，环比天然偏低，不说明就会被当成「掉量」
            notes.append("环比的当期含尚未走完的今天，比值偏低属正常")

    notes.extend(str(n) for n in (spec.get("notes") or []))
    return notes


def detail_table(title, items, subtotal_uv, pv_head, uv_head):
    """一张明细表（含小计行）。

    为什么事件和页面必须拆成两张表：会话页 45,142 次「页面浏览量」和会话发送 23,431 次
    「点击次数」不是同一量纲，塞进同一个分母算占比得出的百分比没有任何含义 ——
    它既不是「页面里有多少人点了」，也不是「点击里有多少来自这个页面」。
    拆开后各自的分母是同类量，占比才读得通；顺带把原来那列「类型」也省了 —— 表头已自明。
    """
    if not items:
        return ""
    subtotal_pv = sum(d["pv"] for d in items)
    # 标识不单列一栏，而是压在中文名下面一行。
    # 手机上 390px 宽要塞五列，「标识」那 30% 一让出来，数字列就窄到 23,499 被折成
    # 「23,49 / 9」两行 —— 一份数据报告把数字断行是不能接受的。
    # 何况标识本就是中文名的注脚，跟名字放一起比单开一列更好读。
    rows = "".join(
        f"<tr><td>{esc(d['label'])}<div class='mono'>{esc(d['key'])}</div></td>"
        f"<td class='num'>{d['pv']:,}</td><td class='num'>{d['uv']:,}</td>"
        f"<td class='num'>{(d['pv'] / subtotal_pv * 100) if subtotal_pv else 0:.1f}%</td></tr>"
        for d in items
    )
    # 列宽写成百分比：table-layout:fixed 下必须显式给，否则四列均分，
    # 名称列会把中文挤成每行一个字
    return f"""<div class="card"><h2>{esc(title)}</h2>
<table><colgroup><col style="width:40%"><col style="width:22%"><col style="width:20%">\
<col style="width:18%"></colgroup>
<thead><tr><th>名称 / 标识</th><th class="num">{esc(pv_head)}</th>\
<th class="num">{esc(uv_head)}</th><th class="num">占比</th></tr></thead>
<tbody>{rows}
<tr class="sub"><td>小计</td><td class="num">{subtotal_pv:,}</td>\
<td class="num">{subtotal_uv:,}</td><td class="num">100.0%</td></tr></tbody></table></div>"""


def _cmp_line(prefix, cur_pv, prev_pv, span_txt, full_txt):
    """一行环比。prefix 在混合维度下点明比的是哪个维度，单维度时留空。"""
    tag = f"{esc(prefix)} " if prefix else ""
    if isinstance(prev_pv, int) and prev_pv > 0:
        rate = (cur_pv - prev_pv) / prev_pv
        arrow, color = ("↑", "#047857") if rate >= 0 else ("↓", "#b91c1c")
        return (
            f'<div class="cmp" style="color:{color}">{tag}较上一周期（{esc(span_txt)}）'
            f'{arrow}{abs(rate) * 100:.1f}%'
            f'<span class="muted">（上期 {prev_pv:,} 次）</span></div>'
        )
    return (
        f'<div class="cmp muted">{tag}上一周期（{esc(full_txt)}）无数据，不计算环比'
        f'　—— 若该区间早于埋点数据保留期，属正常</div>'
    )


def render_html(spec, detail, series, series_by_key, totals, prev, notes, avg_days):
    """渲染报告。样式全部内联、图表为手写 SVG，**无任何外部资源引用** ——
    报告是离线附件，断网/内网打开必须完整可读。

    totals = {"pv", "uv", "eventUv", "pageUv", "eventPv", "pagePv", "dimension"}
    prev   = {"event": int|None, "page": int|None} 或 None（未开环比）
    """
    total_pv, total_uv = totals["pv"], totals["uv"]
    dimension = totals["dimension"]
    event_pv, page_pv = totals["eventPv"], totals["pagePv"]
    event_uv, page_uv = totals["eventUv"], totals["pageUv"]
    start_day, end_day = spec["range"]["start"], spec["range"]["end"]
    rng = f"{start_day} ~ {end_day}"
    range_days = (
        datetime.strptime(end_day, "%Y-%m-%d") - datetime.strptime(start_day, "%Y-%m-%d")
    ).days + 1
    now_bj = datetime.now(BEIJING)
    includes_today = bool(spec.get("includesToday"))

    # 日均：读者拿到「30 天 89,488 次」没有体感，得自己心算除以 30 才知道是什么量级。
    # 含今天时必须按已走完的天数算 —— 用未走完的今天做分母会把日均系统性拉低。
    #
    # 日均挂在对应 PV 块下面的副行，而不是自己单独占一个 KPI 块：日均本就是
    # 「该维度 PV ÷ 天数」，贴着分子放，混合维度下才不必再解释「这个日均是谁的」；
    # 同时也避免混合场景把 KPI 区撑到 5 块 —— 手机上会折成三行，主次全乱。
    def avg_sub(pv):
        if not avg_days:
            return ""
        avg = pv / avg_days
        avg_txt = f"{avg:,.0f}" if avg >= 10 else f"{avg:,.1f}"
        suffix = f"（按 {avg_days} 天）" if includes_today else ""
        return f'<div class="s">日均 {avg_txt}{suffix}</div>'

    def kpi(value, label, sub=""):
        return f'<div class="kpi"><div class="v">{value:,}</div><div class="l">{esc(label)}</div>{sub}</div>'

    def kpi_row(html):
        return f'<div class="kpis">{html}</div>'

    # KPI 按实际维度渲染。
    #
    # 混合时绝不把「事件触发次数」和「页面浏览量」相加成一个「总触发次数」：那是苹果加橘子，
    # 既不能回答「功能被用了多少次」也不能回答「页面被看了多少次」。明细表已经为此拆成两张，
    # KPI 没有理由再混回去。
    #
    # 用户数同样按维度拆成两个，与两张明细表的小计逐字对齐。
    # 之前这里放的是一个跨维度全局去重的「独立用户数」：它谁的小计都不等于，
    # 读者拿顶部的数去核对下面的表，两边对不上，只会怀疑报告算错了。
    # 相加会把「既点按钮又看页面」的人数两遍，所以两个数刻意各自贴在对应的 PV 旁边，
    # 版面上不构成「可以求和的一列」；真正的全局去重值移到脚注里给出，信息不丢。
    if dimension == "both":
        kpis_html = kpi_row(
            kpi(event_pv, "事件触发次数", avg_sub(event_pv)) + kpi(event_uv, "事件独立用户数")
        ) + kpi_row(
            kpi(page_pv, "页面浏览量", avg_sub(page_pv)) + kpi(page_uv, "页面独立用户数")
        )
    elif dimension == "page":
        # 单维度也不再叫「总浏览量 / 总触发次数」：一个「总」字看不出统计的是页面还是事件，
        # 换成与混合模式一致的措辞，两种报告放在一起读也不会串。
        kpis_html = kpi_row(
            kpi(total_pv, "页面浏览量", avg_sub(total_pv)) + kpi(total_uv, "独立用户数")
        )
    else:
        kpis_html = kpi_row(
            kpi(total_pv, "事件触发次数", avg_sub(total_pv)) + kpi(total_uv, "独立用户数")
        )

    compare_html = ""
    if spec.get("compare"):
        # 上期区间永远写出来：不写的话，「↑188.6%」要读者自己算是跟哪几天比，
        # 「无数据」也分不清是真没量还是整段落在了保留期外。
        p_start, p_end = prev_range_days(start_day, end_day)
        # 同年时用 MM-DD（上方已完整写了本期年份，不会歧义），跨年才写全 —— 跨年最容易看错
        same_year = p_start[:4] == p_end[:4] == start_day[:4]
        span_txt = f"{p_start[5:]} ~ {p_end[5:]}" if same_year else f"{p_start} ~ {p_end}"
        full_txt = f"{p_start} ~ {p_end}"
        pv_ = prev or {}
        if dimension == "both":
            # 分维度各比一条。合成一个「总量环比」看着简洁，但那个百分比的分子分母
            # 都是两种量纲相加的产物，涨跌也无法归因到是点击变多还是页面被看得多。
            compare_html = _cmp_line("事件触发", event_pv, pv_.get("event"), span_txt, full_txt) + _cmp_line(
                "页面浏览", page_pv, pv_.get("page"), span_txt, full_txt
            )
        else:
            compare_html = _cmp_line(
                "", total_pv, pv_.get("event") if dimension == "event" else pv_.get("page"), span_txt, full_txt
            )

    events = [d for d in detail if d["kind"] == "event"]
    pages = [d for d in detail if d["kind"] == "page"]
    tables_html = detail_table("事件明细", events, totals["eventUv"], "触发次数", "用户数") + detail_table(
        "页面明细", pages, totals["pageUv"], "浏览量", "用户数"
    )
    if not tables_html:
        tables_html = (
            '<div class="card"><h2>明细</h2><p class="empty">该时段无数据</p></div>'
        )

    lines, days_axis = chart_lines(series, series_by_key)
    # 只有当序列的最后一天确实是区间末日（=今天）时才做「未完成」标注 ——
    # 否则会把一个已经走完的日子画成虚线空心点，等于凭空造出一个不存在的免责声明
    incomplete = includes_today and bool(days_axis) and days_axis[-1] == end_day
    # 没有日分桶就整张卡片不渲染，而不是画一张写着「该时段无数据」的空卡。
    # 单日查询是有数据的，只是没有「趋势」可言；那句话摆在有数的报告里是明晃晃的自相矛盾。
    # 真正无数据时，顶部已有黄色横幅说明，不必再重复一次。
    chart_card = ""
    if days_axis:
        chart_card = (
            '<div class="card"><h2>每日趋势（触发次数）</h2>'
            + legend_html(lines)
            + svg_line_chart(lines, days_axis, incomplete_last=incomplete)
            + "</div>"
        )

    note_items = "".join(f"<li>{esc(n)}</li>" for n in notes)
    empty_banner = (
        '<div class="banner">该时段无数据 —— 所选事件/页面在此区间内没有任何上报记录。</div>'
        if total_pv == 0
        else ""
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(spec.get('title', '埋点统计'))}</title>
<style>
* {{ box-sizing: border-box; }}
body {{ margin:0; padding:24px; background:#f8fafc; color:#111827;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }}
.wrap {{ max-width:860px; margin:0 auto; }}
.card {{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:16px; }}
h1 {{ font-size:22px; margin:0 0 6px; }}
h2 {{ font-size:15px; margin:0 0 12px; }}
.sub {{ color:#6b7280; font-size:13px; }}
.kpis {{ display:flex; gap:32px; flex-wrap:wrap; margin:14px 0 4px; }}
/* 混合维度下有事件、页面两行 KPI：两行之间收紧，否则中间空出 18px，
   看着像两个不相干的区块，而它们是同一组顶部指标 */
.kpis + .kpis {{ margin-top:10px; }}
.kpi .v {{ font-size:32px; font-weight:700; letter-spacing:-0.5px; }}
.kpi .l {{ color:#6b7280; font-size:13px; }}
/* 日均作为 PV 块的副行：比主标签再淡一档，读者一眼分得出「这是那个数的衍生量」 */
.kpi .s {{ color:#9ca3af; font-size:12px; margin-top:3px; }}
.cmp {{ font-size:14px; margin-top:10px; font-weight:600; }}
.muted {{ color:#9ca3af; font-weight:400; }}
.banner {{ margin-top:14px; padding:10px 12px; border-radius:8px; background:#fffbeb;
          border:1px solid #fde68a; color:#92400e; font-size:13px; }}
/* table-layout:fixed 是移动端能不能看的关键。
   自动布局下 /pages-landing/onboarding-v4/family-people/index 这种长路径会把「标识」列
   顶成不可压缩的最小宽度，整张表撑破 390px 视口；而表格一撑宽，body 的滚动宽度跟着变大，
   卡片被拉长、KPI 也就不再换行 —— 最后整页右侧被裁掉。固定列宽 + 任意位置换行才收得住。 */
table {{ width:100%; table-layout:fixed; border-collapse:collapse; font-size:14px; }}
th,td {{ padding:9px 10px; border-bottom:1px solid #f1f5f9; text-align:left; }}
th {{ color:#6b7280; font-weight:600; font-size:12px; background:#fafafa; }}
/* 数字列绝不断行：宁可列宽紧一点，也不能出现「23,49 / 9」这种被折断的数字 */
.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
/* 只有标识允许任意位置断行 —— 长路径没有可断的空格，不给它开口子就会撑破列宽 */
.mono {{ font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#9ca3af;
        overflow-wrap:anywhere; margin-top:2px; }}
tr.sub td {{ font-weight:700; color:#111827; border-top:1px solid #e5e7eb; border-bottom:none;
            background:#fafafa; }}
.empty {{ color:#9ca3af; text-align:center; padding:24px; }}
.foot {{ font-size:12px; color:#6b7280; line-height:1.7; }}
.foot ul {{ margin:6px 0 0; padding-left:18px; }}
/* 图表宽度撑满、高度按 viewBox 等比走 —— 写死 height 会让窄屏上图被留白挤扁 */
.chart {{ width:100%; height:auto; display:block; }}
.legend {{ display:flex; flex-wrap:wrap; gap:6px 18px; margin:0 0 12px; font-size:13px;
          color:#374151; }}
.lg {{ display:inline-flex; align-items:center; gap:6px; }}
.lg i {{ width:12px; height:12px; border-radius:3px; flex:none; }}
/* SVG 里的字号走 CSS 类而不是 font-size 属性：viewBox 会把整张图等比缩放，
   手机上缩到四成时写死的 10px 只剩 4px。只有走类名，才能在窄屏用媒体查询把
   用户单位顶上去，抵消缩放。断点处的字号是按「缩放后约 12px」倒推出来的。 */
.cy {{ font-size:13px; }}
.cx {{ font-size:14px; }}
.cn {{ font-size:13px; }}
@media (max-width:760px) {{
  body {{ padding:12px; }}
  .card {{ padding:14px; }}
  .kpi .v {{ font-size:26px; }}
  .legend {{ font-size:14px; }}
  .cy {{ font-size:19px; }} .cx {{ font-size:20px; }} .cn {{ font-size:19px; }}
}}
@media (max-width:420px) {{
  .kpis {{ gap:16px 22px; }}
  .cy {{ font-size:26px; }} .cx {{ font-size:28px; }} .cn {{ font-size:26px; }}
}}
</style></head>
<body><div class="wrap">

<div class="card">
  <h1>{esc(spec.get('title', '埋点统计'))}</h1>
  <div class="sub">{esc(rng)} · {range_days} 天</div>
  {kpis_html}
  {compare_html}
  {empty_banner}
</div>

{chart_card}

{tables_html}

<div class="card foot">
  <strong>查询口径</strong>
  <ul>{note_items}</ul>
  <div style="margin-top:10px">数据区间：{esc(rng)}（北京时间）　·　生成时间：{now_bj.strftime('%Y-%m-%d %H:%M')}（北京时间）</div>
</div>

</div></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="埋点统计报告生成器")
    ap.add_argument("--spec", required=True, help="QuerySpec JSON 文件路径")
    ap.add_argument("--out-dir", default="", help="HTML 输出目录，默认系统临时目录")
    ap.add_argument("--file-name", default="", help="输出文件名")
    args = ap.parse_args()

    try:
        with open(args.spec, "r", encoding="utf-8") as f:
            spec = json.load(f)

        log(f"开始查询：{spec.get('title')} {spec['range']['start']}~{spec['range']['end']}")
        res = run_query(spec)
        detail, series, series_by_key, total_pv = aggregate(res["rows"], spec, res["uvByKey"])
        total_uv = res["totalUv"]
        dimension, event_pv, page_pv, has_events, has_pages = split_dimension(detail, spec)
        log(
            f"聚合完成：{len(detail)} 项 · 维度 {dimension} · "
            f"事件 {event_pv} 次 / 页面 {page_pv} 次 · 独立用户 {total_uv} 人"
        )

        # 日均的分母：含今天时今天是不完整的一天，算进去会把日均系统性拉低。
        # 区间只有今天一天时分母归零 —— 此时不显示日均，硬算出来的数字没有意义。
        range_days = (
            datetime.strptime(spec["range"]["end"], "%Y-%m-%d")
            - datetime.strptime(spec["range"]["start"], "%Y-%m-%d")
        ).days + 1
        avg_days = range_days - 1 if spec.get("includesToday") else range_days
        # 分母无效、或者压根没有数据时都不给日均：一张全 0 的报告上摆个「日均 0.0 次」
        # 只是噪声，读者还要多花一眼确认它没别的含义
        if avg_days < 1 or total_pv == 0:
            avg_days = None

        notes = build_notes(
            spec,
            res["excludedInternal"],
            res["internalOk"],
            has_events,
            has_pages,
            avg_days,
            bool(series),
            total_uv,
        )
        totals = {
            "pv": total_pv,
            "uv": total_uv,
            "eventUv": res["eventUv"],
            "pageUv": res["pageUv"],
            "eventPv": event_pv,
            "pagePv": page_pv,
            "dimension": dimension,
        }
        html = render_html(spec, detail, series, series_by_key, totals, res["prev"], notes, avg_days)

        out_dir = args.out_dir or os.path.join(
            os.environ.get("TEMP") or os.environ.get("TMPDIR") or "/tmp", "tracking-reports"
        )
        os.makedirs(out_dir, exist_ok=True)
        file_name = args.file_name or f"tracking_{datetime.now(BEIJING).strftime('%Y%m%d_%H%M%S')}.html"
        out_path = os.path.join(out_dir, file_name)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        log(f"报告已生成：{out_path}")

        # summary 里的数同样要能表达维度，否则聊天摘要会重蹈「苹果加橘子」的覆辙。
        # totalPv 保留为兼容字段（= eventPv + pagePv）：单维度下它就是那个维度的总量，
        # 语义无歧义；混合下 Node 侧的 buildSummaryText 会改用 eventPv/pagePv，不读它。
        # compareRate 同理：混合时置 None，改给两个分维度的比率 ——
        # 留一个含混的总环比在那里，迟早有人直接拿去用。
        def _rate(cur_pv, prev_pv):
            return ((cur_pv - prev_pv) / prev_pv) if isinstance(prev_pv, int) and prev_pv > 0 else None

        prev = res["prev"] or {}
        event_rate = _rate(event_pv, prev.get("event"))
        page_rate = _rate(page_pv, prev.get("page"))
        compare_rate = None if dimension == "both" else (event_rate if dimension == "event" else page_rate)
        print(json.dumps({
            "htmlPath": out_path,
            "summary": {
                "title": spec.get("title", "埋点统计"),
                "range": f"{spec['range']['start']} ~ {spec['range']['end']}",
                "dimension": dimension,
                "totalPv": total_pv,
                "eventPv": event_pv,
                "pagePv": page_pv,
                "totalUv": total_uv,
                "compareRate": compare_rate,
                "eventCompareRate": event_rate,
                "pageCompareRate": page_rate,
                "top": [{"label": d["label"], "pv": d["pv"]} for d in detail[:3]],
            },
        }, ensure_ascii=False), flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        # 失败也必须给 stdout 一行合法 JSON：Node 侧只解析 stdout，
        # 什么都不输出会让上游拿到空串再炸一次，错因彻底丢失。
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())

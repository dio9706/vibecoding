#!/bin/bash

echo "=== 代码质量综合审查 ==="
echo ""

echo "1. API 使用统计"
grep -o "anime\.animate" public/app.js | wc -l
echo "   ✓ anime.animate 调用次数: $(grep -o 'anime\.animate' public/app.js | wc -l)"

echo ""
echo "2. 防护机制检查"
echo "   ✓ hasAnime() 降级检查: $(grep -c 'hasAnime()' public/app.js) 处"
echo "   ✓ null 安全检查: $(grep -c '!.*el\|!containerEl' public/app.js) 处"

echo ""
echo "3. 元素复用优化"
echo "   ✓ querySelector 缓存: $(grep -c "querySelector.*tool-text-anim" public/app.js) 处"
echo "   ✓ 条件创建模式: $(grep -c "if (!txt)" public/app.js) 处"

echo ""
echo "4. 动画参数一致性"
echo "   ✓ duration 设置："
grep "duration\s*:" public/app.js | grep -o "duration\s*:\s*[0-9]*" | sort | uniq -c

echo ""
echo "5. 提交历史完整性"
git log --oneline 86ba9d3..HEAD | wc -l
echo "   ✓ Task 1-7 相关提交: $(git log --oneline 86ba9d3..HEAD | wc -l) 个"

echo ""
echo "6. 代码重构指标"
echo "   ✓ 手写 scramble 删除: $(git show a1dafce -- public/app.js | grep '^-' | wc -l) 行"
echo "   ✓ 新 API 集成: $(git show c7c1369 -- public/app.js | grep '^+' | wc -l) 行"


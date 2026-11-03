#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lib_VolM 宿主机单元测试构建脚本（不进入 MCU 构建）
#
# 用法：
#   bash UnitTest/build.sh          # 编译并运行当前阶段全部用例
#   CC=clang bash UnitTest/build.sh # 指定编译器
#
# 约定：每个 UnitTest/test_*.c 是一个独立可执行用例，失败返回非 0。
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

CC=${CC:-gcc}
CFLAGS="-std=c99 -Wall -Wextra -Werror -Iinc -Isrc"
BUILD_DIR="UnitTest/build"

mkdir -p "$BUILD_DIR"

# 被测源文件（随阶段推进增加）
LIB_SRC="src/vol_cfg.c src/vol_calc.c src/vol_filt.c src/vol_sm.c src/vol.c"

echo "=========================================================="
echo " Lib_VolM 单元测试   编译器: $($CC --version | head -n 1)"
echo " 标准: C99  -Wall -Wextra -Werror"
echo "=========================================================="

# --- 编译期检查：C11 路径（验证 _Static_assert 分支同样成立） --------------
echo "[1/2] C11 编译检查（_Static_assert 路径）"
$CC -std=c11 -Wall -Wextra -Werror -Iinc -Isrc -c src/vol_cfg.c -o "$BUILD_DIR/vol_cfg_c11.o"
echo "      OK"

# --- 用例编译与运行 -------------------------------------------------------
echo "[2/2] C99 用例编译并运行"
for test_src in UnitTest/test_*.c; do
    name=$(basename "$test_src" .c)
    echo "  -> $name"
    $CC $CFLAGS $LIB_SRC "$test_src" -o "$BUILD_DIR/$name"
    "$BUILD_DIR/$name"
done

echo "=========================================================="
echo " 全部用例通过"
echo "=========================================================="

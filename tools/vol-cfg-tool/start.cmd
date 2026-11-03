@echo off
REM ============================================================
REM  Lib_VolM 配置工具启动器
REM
REM  工具是单文件 HTML（dist/index.html），无任何网络请求，
REM  双击即可使用，本脚本只是给"习惯双击启动"的人一个入口。
REM  若浏览器策略拦截 file:// 打开，用下面的 HTTP 兜底：
REM      python -m http.server 8616 --directory dist
REM  然后浏览器访问 http://127.0.0.1:8616/index.html
REM ============================================================
setlocal
set "TOOL=%~dp0"

if not exist "%TOOL%dist\index.html" (
    echo [错误] 未找到 %TOOL%dist\index.html
    echo 请先在 vol-cfg-tool 目录执行: npm install ^&^& npm run build
    pause
    exit /b 1
)

start "" "%TOOL%dist\index.html"
endlocal

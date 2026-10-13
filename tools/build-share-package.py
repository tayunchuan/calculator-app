# -*- coding: utf-8 -*-
"""
把 calculator-app 打包成可以发给别人的两种形态：

1. 计算器v1.0-离线版.zip
   解压后是一个文件夹，内含 index.html / styles.css / app.js / 使用说明.txt
   适合电脑上用，结构清晰，改起来方便。

2. 计算器v1.0-单文件版.html
   把 CSS 和 JS 全部内联进一个 HTML，单个文件双击即用。
   适合在微信 / 邮件 / 网盘里只发一个文件、对方不会解压的场景。

用法：
    python tools/build-share-package.py
产物统一放在 dist/ 目录下。
"""

import os
import re
import sys
import zipfile
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
VERSION = "v1.0"

USAGE_TEXT = """计算器 {version} · 使用说明
========================================

【怎么打开】
  1. 先把压缩包完整解压出来（不要直接在压缩包里双击打开）
  2. 双击 index.html，浏览器就会打开计算器
  3. 建议用 Chrome、Edge、Firefox 等常见浏览器

【有什么功能】
  · 计算   四则运算，支持键盘直接输入数字和 + - * /
  · 换算   长度 / 重量 / 温度 / 面积 / 体积
  · 日期   日期相差、日期加减推演、年龄与纪念日
  · 历史   上面三块的操作会自动留痕，可搜索、可筛选、可点开重算
  · 设置   千分位开关、历史条数上限、导出备份 / 导入备份

【重要：你的数据在哪】
  · 所有记录只存在你自己电脑的浏览器里，不会上传到任何服务器，
    作者和转发给你的人也看不到你的数据
  · 请不要用「无痕 / 隐私模式」打开，那种模式关掉窗口数据就没了
  · 换电脑、换浏览器，数据不会跟着走。想迁移就用：
    设置 → 导出备份，得到 json 文件，在新环境里用「导入备份」还原
  · 浏览器「清除浏览数据」会清掉记录，重要数据建议定期导出备份

【关于手机】
  这一版是按电脑宽屏设计的，手机上打开会挤、需要横向滚动，
  能用但不舒服。想在手机上用得顺手，需要单独做移动端适配。

【注意】
  · 程序本身完全离线，不联网也能跑，不放心可以断网试
  · 界面上不认识的东西（比如 PRD.md、tests/）是开发用的，没放进这个包
"""


def read(name):
    with open(os.path.join(ROOT, name), "r", encoding="utf-8") as f:
        return f.read()


def build_folder_version():
    """生成解压即用的文件夹 + zip 压缩包"""
    stage = os.path.join(DIST, "计算器 {}".format(VERSION))
    os.makedirs(stage, exist_ok=True)

    for name in ("index.html", "styles.css", "app.js"):
        with open(os.path.join(stage, name), "w", encoding="utf-8", newline="") as f:
            f.write(read(name))

    with open(os.path.join(stage, "使用说明.txt"), "w", encoding="utf-8") as f:
        f.write(USAGE_TEXT.format(version=VERSION))

    zip_path = os.path.join(DIST, "计算器{}-离线版.zip".format(VERSION))
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("index.html", "styles.css", "app.js", "使用说明.txt"):
            z.write(os.path.join(stage, name),
                    arcname="计算器 {}/{}".format(VERSION, name))
    return zip_path


def build_single_file():
    """把 CSS / JS 内联，产出一个自包含的 HTML"""
    html = read("index.html")
    css = read("styles.css")
    js = read("app.js")

    html = re.sub(r'<link rel="stylesheet" href="styles\.css">',
                  lambda m: "<style>\n{}\n</style>".format(css),
                  html, count=1)
    html = re.sub(r'<script src="app\.js"></script>',
                  lambda m: "<script>\n{}\n</script>".format(js),
                  html, count=1)

    assert "styles.css" not in html, "CSS 未成功内联"
    assert 'src="app.js"' not in html, "JS 未成功内联"

    out = os.path.join(DIST, "计算器{}-单文件版.html".format(VERSION))
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    return out


def main():
    os.makedirs(DIST, exist_ok=True)
    zip_path = build_folder_version()
    single = build_single_file()
    today = datetime.date.today().isoformat()

    print("打包完成（{}）".format(today))
    for p in (zip_path, single):
        print("  {:<28} {:>8.1f} KB".format(
            os.path.basename(p), os.path.getsize(p) / 1024))


if __name__ == "__main__":
    sys.exit(main())

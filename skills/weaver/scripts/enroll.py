#!/usr/bin/env python3
"""由用户在本机终端隐藏录入凭证，不向聊天或命令参数传递秘密。"""

import argparse
import getpass
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', choices=('dev', 'pre', 'prod'), required=True)
    parser.add_argument('--replace', action='store_true', help='明确替换该环境已有钥匙串凭证')
    arguments = parser.parse_args()
    if not sys.stdin.isatty():
        raise SystemExit('请由用户在本机交互终端运行；不接受聊天、参数或重定向凭证输入。')
    physical = 'prod' if arguments.env == 'prod' else 'test（dev/pre 共用）'
    print(f'将为 {physical} 环境{"替换" if arguments.replace else "首次保存"}钥匙串账号密码，并失效该环境旧会话。')
    if input('确认此项本机凭证操作请输入 保存：').strip() != '保存':
        raise SystemExit('未确认，没有读取或保存凭证。')
    value = {
        'account': getpass.getpass('账号（隐藏输入）：'),
        'password': getpass.getpass('密码（隐藏输入）：'),
    }
    command = ['node', str(Path(__file__).with_name('weaver.js')), 'credential-store', '--env', arguments.env]
    if arguments.replace:
        command.append('--replace')
    result = subprocess.run(command, input=json.dumps(value), text=True, check=False)
    value.clear()
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()

#!/bin/bash
# macOS: دبل كليك يفتح Terminal ويشغّل التسطيب
cd "$(dirname "$0")" && bash ./install.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."

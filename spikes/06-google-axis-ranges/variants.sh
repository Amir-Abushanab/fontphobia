#!/bin/sh
# Fetches the css2 for each query N times and saves every distinct latin-slice
# URL (and its file) into fonts/variants/. Prints a count per URL hash.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
N=${N:-40}
mkdir -p fonts/variants
for fam in 'Roboto+Flex:wght@400..700' 'Inter:wght@400..700' 'Inter:opsz,wght@14..32,100..900'; do
  slug=$(echo "$fam" | tr ':@,.+' '_____')
  for i in $(seq 1 "$N"); do
    css=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=$fam&display=swap")
    u=$(echo "$css" | awk '/\/\* latin \*\//{f=1} f&&/src:/{print; exit}' | sed -E 's/.*url\(([^)]+)\).*/\1/')
    h=$(echo "$u" | shasum | cut -c1-8)
    f="fonts/variants/$slug-$h.woff2"
    if [ ! -f "$f" ]; then curl -s "$u" -o "$f"; echo "$css" > "fonts/variants/$slug-$h.css"; echo "$u" > "fonts/variants/$slug-$h.url"; fi
    echo "$fam $h"
  done
done | sort | uniq -c

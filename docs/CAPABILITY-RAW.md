# M0 capability raw results

server: `http://127.0.0.1:8090`  ·  13 cases, 0 failed  ·  132.5s total

## A. whole-page document parsing

| case | wall s | prefill ms | decode ms | decode tok/s | in tok | out tok | finish | char acc | repeat |
|---|---|---|---|---|---|---|---|---|---|
| doc-qianziwen | 7.24 | 7027.418 | 176.797 | 141.4 | 566 | 26 | stop | 85.7% | 0 |
| doc-dense-equations | 12.51 | 2328.695 | 10073.066 | 160 | 2316 | 1613 | stop | 79.1% | 0.1125 |
| doc-handwrite-formula | 12.49 | 6266.529 | 5985.576 | 159.2 | 4100 | 954 | stop | 74.6% | 0.1772 |
| doc-receipt | 3.31 | 1413.803 | 1817.173 | 164.5 | 1499 | 300 | stop | 100.0% | 0 |

## B/C/D. task, language and structural probes

| case | group | wall s | in tok | out tok | decode tok/s | signals |
|---|---|---|---|---|---|---|
| doc-qianziwen | A-page | 7.24 | 566 | 26 | 141.4 | acc=85.7% |
| doc-dense-equations | A-page | 12.51 | 2316 | 1613 | 160.0 | acc=79.1%; REPEAT |
| doc-handwrite-formula | A-page | 12.49 | 4100 | 954 | 159.2 | acc=74.6%; REPEAT |
| doc-receipt | A-page | 3.31 | 1499 | 300 | 164.5 | acc=100.0% |
| task-table | B-task | 1.05 | 308 | 141 | 166.0 | <fcel>:y; <nl>:y |
| task-formula | B-task | 1.02 | 462 | 125 | 166.1 | \:y; ^:y |
| task-text | B-task | 0.44 | 515 | 24 | 164.2 | - |
| lang-ja | C-lang | 0.72 | 427 | 78 | 164.7 | script=85.6% |
| lang-ko | C-lang | 0.91 | 427 | 109 | 164.6 | script=83.7% |
| lang-ru | C-lang | 1.23 | 495 | 156 | 165.4 | script=91.0% |
| lang-zh-vertical | C-lang | 0.41 | 503 | 19 | 162.1 | acc=80.0% |
| kie-receipt | D-probe | 1.96 | 1559 | 145 | 164.8 | json=valid |
| probe-bbox | D-probe | 0.59 | 543 | 41 | 165.0 | bbox=0/3 |

## E. stability

- prompt adherence (5 runs, same input): mean pairwise accuracy **100.0%**, min 100.0%
- repetition stress (8 runs, dense page): max duplicate-24gram ratio **0.11249619945272119**, hit-rate(>5%) 100%

## Context headroom (16384)

| case | used tok | ratio | truncated |
|---|---|---|---|
| doc-qianziwen | 592 | 3.6% | no |
| doc-dense-equations | 3929 | 24.0% | no |
| doc-handwrite-formula | 5054 | 30.8% | no |
| doc-receipt | 1799 | 11.0% | no |
| task-table | 449 | 2.7% | no |
| task-formula | 587 | 3.6% | no |
| task-text | 539 | 3.3% | no |
| lang-ja | 505 | 3.1% | no |
| lang-ko | 536 | 3.3% | no |
| lang-ru | 651 | 4.0% | no |
| lang-zh-vertical | 522 | 3.2% | no |
| kie-receipt | 1704 | 10.4% | no |
| probe-bbox | 584 | 3.6% | no |

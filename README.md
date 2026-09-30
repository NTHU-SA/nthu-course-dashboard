# 清華課程

11510 學期課程資料網站：[開啟網站](https://nthu-sa.github.io/nthu-course-dashboard/)。

保留薄荷綠／紫色 Soft Glass 介面，提供共用篩選、課程列表與詳情、CSV 匯出、時段熱圖、分布統計及歷史變動。介面使用繁體中文、系統字型，沒有前端套件、CDN 或瀏覽器端外部 API。

## 資料與指標

來源為 [NTHU-SA/NTHU-Data-Scraper](https://github.com/NTHU-SA/NTHU-Data-Scraper) 的公開 `data` 分支。本專案只讀取 `courses/semesters/11510.json` 與舊路徑 `data/courses/semesters/11510.json`，不執行爬蟲，也不修改來源。正規化歷史自 2026-06-15 起；不支援其他學期或原始中文欄位格式。

每次產生先固定來源 SHA，沿完整 Git 歷史的 first-parent 順序讀取。內容相同、排序變化與路徑搬移不會新增觀測點；真實內容變更、移除及重新出現會保留。資料時間是 commit 時間，不是固定間隔或即時資料。第一筆是比較基準，課程移除不代表停開。來源連結始終指向原始 scraper repository。

沒有選課人數，不能推算熱門程度或剩餘名額。人限空白為未提供，0 的語意未確認，並非不限人數；合計與覆蓋率只計正數人限。異常數值不計入合計。時段按同課同星期同節次去重，缺漏與異常時段不列入熱圖。教師與教室依原始合列字串分組，不拆分。學分保留小數與未知狀態。停開、選課限制與擋修以校方公告為準。

## 本機產生

需要 Git、Python 3.12 以上；產生器僅使用標準函式庫。來源必須是**外部 repository 的完整歷史**，不接受本專案或 shallow clone。以下命令可於 repository 根目錄執行；Windows PowerShell 的路徑使用 `.\.source`。

```sh
git clone --filter=blob:none --single-branch --branch data --no-tags --no-checkout https://github.com/NTHU-SA/NTHU-Data-Scraper.git .source
python generate_course_dashboard.py --source-dir .source --output site
python -m http.server 8000 --directory site
```

開啟 `http://localhost:8000/`。所有資產與 JSON 使用相對 URL，也支援 Pages 的 `/nthu-course-dashboard/` 子路徑。後續更新先執行 `git -C .source fetch origin data`，再產生。可用 `--ref <data-commit-SHA>` 重現固定來源，或 `--since 2026-06-15 --until 2026-09-30` 限定期間；日期以台北日界線解讀，帶時間的值必須含時區，起日包含前一筆可用基準。

輸出只有 HTML、CSS、JS、manifest、內容雜湊命名的 JSON 及產物識別檔。產生器僅可替換自身建立的輸出目錄；先完成暫存及 JSON 驗證，再原子替換。重複課號、損壞 JSON、Git 錯誤與缺失來源會明確失敗，不覆寫既有網站；若回復失敗，錯誤會指出保留舊網站的 recovery 目錄。`site/`、來源 clone 與資料集不提交。

## 測試

pytest、ruff 僅為開發工具；JavaScript 使用 Node 原生測試 runner，不需 npm 安裝或建置。

```sh
python -m pip install -r requirements-dev.txt
python -m ruff check .
python -m ruff format --check .
python -m pytest -q
node --test tests/course_dashboard.test.cjs
```

產生 `site/` 後，可設定 `COURSE_SOURCE_DIR=.source` 執行 `python -m pytest -q tests/test_source_history.py`，確認網站最新資料與其固定 SHA 完全一致。PowerShell 設定環境變數方式為 `$env:COURSE_SOURCE_DIR = ".\.source"`。

## GitHub Pages

Repository 必須公開，Settings → Pages → Source 選 **GitHub Actions**。本 repository 已使用 workflow 模式，無需自訂網域。

`.github/workflows/pages.yml` 在 `main` push、手動執行及每兩小時（UTC 的奇數分 17）重新抓取來源完整 `data` 歷史、測試並產生網站。排程可能延遲；畫面仍顯示實際來源 commit 時間。Pull request 也執行測試及產生，但不部署。只有可信的 `main` 事件上傳 `site/` 並部署至 `github-pages` environment；不包含測試、來源 `.git` 或本機材料。任何來源、測試或建置錯誤都使 workflow 失敗，保留最後成功部署。並行執行會排隊，避免部署互相覆蓋。

Actions 以已驗證 release SHA 固定版本，build 僅有 `contents: read`，deploy 僅有 `pages: write` 與 `id-token: write`。不需要額外 secrets、後端或組織設定。

## 授權與來源

本網站與歷史分析工具由 [NTHU-SA/NTHU-Data-Scraper](https://github.com/NTHU-SA/NTHU-Data-Scraper) 的課程儀表板移植，移除 Scrapy、Pydantic、爬蟲與無關校園資料，獨立於來源專案部署。保留 [MIT LICENSE](LICENSE) 與 `Copyright (c) 2024 國立清華大學學生會` 聲明。課程資料原始來源為清華大學課程開放資料，使用及選課規則以校方公告為準。

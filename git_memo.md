### 作成
echo "# u" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/umaru-channn/markdown_editor.git
git push -u origin main
### 反映
git add .
git commit -m "メッセージ"
git push
### 削除
rm -rf .git
### 変更
git add set-url origin url
### 例: .env ファイルを追跡対象から外す
git rm --cached .env
### 移動
git switch
### 更新
git fetch
git merge
git pull
### 確認
git branch -a
# 1つ前のコミットに戻る
git reset --hard HEAD~1
# または、特定のコミットIDに戻る
git reset --hard 1d5506b432a9ae8bc849afd9516f491cf9b086cf
# 直前のコミット内容の反映
git add .
git commit --amend --no-edit
git push origin main --force
# 履歴をきれいにするor標準マージ
git pull --rebase
git pull --no-ff
# ブランチの削除
git push origin --delete
git branch -D 
set BRANCH_NAME=live_preview
git push origin --delete %BRANCH_NAME% && git branch -D %BRANCH_NAME%
# gitのリモートの最新状態を受け取る
git pull origin main
# マージする
git merge pdf_beta
# 上書きマージ
git switch pdf_beta
git rebase main
git switch main
git merge pdf_beta
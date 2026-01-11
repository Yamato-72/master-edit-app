FROM node:20-slim

WORKDIR /app

# package.json を先にコピー（キャッシュ効かせるため）
COPY package*.json ./

RUN npm install

# 残りのファイルをコピー
COPY . .

# Cloud Run が使うポート
ENV PORT=8080
EXPOSE 8080

# サーバー起動
CMD ["node", "app.js"]

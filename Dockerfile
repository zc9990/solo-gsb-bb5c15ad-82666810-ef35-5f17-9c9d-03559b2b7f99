# 盲文标签排版台
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先拷贝依赖清单，利用镜像层缓存完成安装
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝应用源码
COPY server.js ./
COPY lib ./lib
COPY public ./public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]

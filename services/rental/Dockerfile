# syntax=docker/dockerfile:1
# =============================================================================
# Dockerfile multi-stage cho service NestJS trong monorepo pnpm.
#
# BUILD TỪ GỐC REPO (cần pnpm-lock.yaml và tsconfig.base.json ở gốc):
#   docker build -f services/rental/Dockerfile -t realestate/rental .
#
# Khi copy template thành service mới (ví dụ identity) KHÔNG cần sửa file này nếu truyền:
#   docker build -f services/identity/Dockerfile --build-arg SERVICE_DIR=services/identity \
#     -t realestate/identity .
# (hoặc đổi giá trị mặc định của SERVICE_DIR bên dưới).
#
# Chạy: SERVICE_NAME là BẮT BUỘC (service dừng ngay nếu thiếu):
#   docker run --rm -p 3003:3003 -e SERVICE_NAME=rental realestate/rental
# =============================================================================
ARG NODE_VERSION=22
ARG SERVICE_DIR=services/rental

# ---------- base: Node 22 LTS + pnpm (đúng phiên bản trong "packageManager" của package.json gốc) ----------
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---------- build: cài phụ thuộc, biên dịch TypeScript, đóng gói bản production ----------
FROM base AS build
ARG SERVICE_DIR
# Chỉ copy file khai báo phụ thuộc trước để tận dụng cache lớp khi code đổi mà phụ thuộc không đổi
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter ./${SERVICE_DIR}...
COPY ${SERVICE_DIR} ${SERVICE_DIR}
RUN pnpm --filter ./${SERVICE_DIR} build
# Bản production gọn: chỉ dist + phụ thuộc runtime (không có devDependencies)
RUN pnpm --filter ./${SERVICE_DIR} deploy --legacy --prod /out

# ---------- runtime: ảnh nhỏ, chạy bằng user không phải root ----------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    SWAGGER_ENABLED=false
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Người dùng "node" (uid 1000) có sẵn trong ảnh node; KHÔNG chạy bằng root
USER node
EXPOSE 3000
# Gọi /health (200 = ổn, 503 = phụ thuộc chết). busybox wget trả mã khác 0 khi HTTP lỗi.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# `node` chạy trực tiếp (không qua pnpm/npm) để nhận SIGTERM và tắt gọn (graceful shutdown)
CMD ["node", "dist/main.js"]

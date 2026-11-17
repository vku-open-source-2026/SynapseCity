# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
# typescript-eslint 8 does not yet declare TypeScript 7 as a peer; keep the
# install deterministic until the lint stack widens its range.
RUN npm ci --legacy-peer-deps

COPY . .

ARG VITE_BASE_API_URL
ENV VITE_BASE_API_URL=$VITE_BASE_API_URL

RUN npm run build

FROM nginx:1.27-alpine

COPY ./nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

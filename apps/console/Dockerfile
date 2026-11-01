# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_BASE_API_URL
ARG VITE_LEADERBOARD_URL
ENV VITE_BASE_API_URL=$VITE_BASE_API_URL
ENV VITE_LEADERBOARD_URL=$VITE_LEADERBOARD_URL

RUN npm run build

FROM nginx:1.27-alpine

COPY ./nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

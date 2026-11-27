# Tài liệu tham khảo API Cổng Đóng góp

**Language / Ngôn ngữ:** [English](../CONTRIBUTION_API.md) | [Tiếng Việt](CONTRIBUTION_API.md)

URL cơ sở: **https://contribution.synapsecity.sbs**

Tài liệu này mô tả hợp đồng HTTP do bộ định tuyến Rust Axum triển khai tại
[`apps/contribution-service/src/routes`](../../apps/contribution-service/src/routes).
Tài liệu bao gồm các thao tác đọc công khai và tiếp nhận dữ liệu từ công dân,
quy trình JWT dành riêng cho một quản trị viên của cổng, các điểm cuối kiểm
duyệt, xác nhận xuất dữ liệu nội bộ, xuất CSV, cấu hình/bản đồ tile và các
điểm kiểm tra tình trạng hoạt động.

Cổng đóng góp là dịch vụ thu thập dữ liệu Tier-3 của SynapseCity. Các tuyến
`/api/sos` cũ tiếp nhận báo cáo từ công dân và cho phép quản trị viên của cổng
thay đổi trạng thái tiếp nhận; chúng **không** phải là API nghiệp vụ
SynapseCitySOS. Không điểm cuối nào ở đây cung cấp hoạt động điều phối, EOP,
SITREP, AAR, nguồn cấp dữ liệu nguy hiểm hoặc trung tâm chỉ huy khẩn cấp.

## Quy ước

- Các đường dẫn bên dưới là đường dẫn tương đối so với URL cơ sở. Edge công
  khai chuyển tiếp `/api/*` đến dịch vụ này; `/health` và `/ready` cũng khả dụng
  ở mạng nội bộ.
- Phản hồi JSON thành công dùng HTTP **200**, kể cả các thao tác tạo mới và kiểm
  duyệt. Dịch vụ này không trả 201 cho các thao tác ghi thành công.
- Thân yêu cầu dùng `Content-Type: application/json` trừ khi một điểm cuối quy
  định khác. Tham số đường dẫn là chuỗi; hãy mã hóa URL khi cần thiết.
- Thứ tự khóa trong đối tượng JSON không có ý nghĩa. Thứ tự mảng có ý nghĩa ở
  những nơi được ghi rõ (bản gửi đang chờ, báo cáo SOS và bảng xếp hạng).
- ID là chuỗi mờ (opaque). Không tự tạo ID; hãy dùng ID do các điểm cuối danh
  sách trả về.
- Giá trị `timestamp` của contribution là chuỗi UTC không có múi giờ, chẳng hạn
  `2026-11-26T10:20:30.123456`. Các giá trị `created_at`, `updated_at` và
  `city_synced_at` do storage tạo ra là chuỗi RFC 3339 UTC có hậu tố `+00:00`.
- Giới hạn mặc định cho thân yêu cầu là **25 MiB**
  (`BODY_LIMIT_BYTES=26214400`). Thân yêu cầu lớn hơn trả **413**. Thời gian chờ
  mặc định cho toàn bộ yêu cầu là **60 giây** (`REQUEST_TIMEOUT_SECS`); khi hết
  thời gian chờ, yêu cầu trả **408**.
- Phản hồi gồm `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` và `X-XSS-Protection: 1; mode=block`. Phản hồi trong
  production cũng có HSTS.

## Xác thực

### Điểm cuối ẩn danh

Không cần header `Authorization` đối với:

- tất cả điểm kiểm tra tình trạng hoạt động/sẵn sàng;
- `GET /api/features`;
- `POST /api/contributions`;
- `GET /api/leaderboard`;
- `POST /api/sos`;
- `GET /api/export_csv`;
- cả hai điểm cuối `/api/map/*`.

`POST /api/auth/login` và `POST /api/auth/refresh` cũng không yêu cầu token hiện
có, nhưng đăng nhập yêu cầu thông tin xác thực quản trị viên đã được cấu hình.
Không có điểm cuối đăng ký công khai.

### Token Bearer của quản trị viên

Các điểm cuối quản trị cổng còn lại đều yêu cầu:

```http
Authorization: Bearer <access_token>
```

Dịch vụ hỗ trợ một tài khoản quản trị viên được cấu hình qua biến môi trường.
Access token là JWT HS256 với các claim `sub`, `exp` và `type: "access"`. Thời
hạn mặc định của access token là 60 phút (`ACCESS_TOKEN_EXPIRE_MINUTES`); refresh
token có `type: "refresh"` và thời hạn mặc định là 7 ngày
(`REFRESH_TOKEN_EXPIRE_DAYS`). Thao tác làm mới token sẽ luân chuyển cả hai
token. Thông tin xác thực cổng này tách biệt với giao diện City `/v1/auth/*` đã
ngừng hoạt động và với các phiên làm việc SynapseDX workspace.

Hành vi của bộ trích xuất Bearer cố tình tuân thủ hợp đồng FastAPI trước đây:

| Điều kiện | Trạng thái | Phản hồi |
| --- | --- | --- |
| Thiếu header `Authorization` hoặc giá trị không bắt đầu bằng `Bearer ` | 403 | `{"detail":"Not authenticated"}` |
| Token không hợp lệ/đã hết hạn | 401 | `{"detail":"Could not validate credentials"}` |
| Token hợp lệ nhưng sai loại token | 401 | `{"detail":"Invalid token type"}` |
| Token hợp lệ nhưng subject trống | 401 | `{"detail":"Could not validate credentials"}` |

Phản hồi 401 có header `WWW-Authenticate: Bearer`. Dịch vụ này không có role
claim hay ma trận quyền; access token hợp lệ chính là thông tin xác thực quản trị
viên cho tất cả các tuyến được bảo vệ bằng Bearer.

### Bí mật đồng bộ nội bộ

`POST /api/sync/ack` là điểm cuối server-to-server, không phải điểm cuối dành
cho trình duyệt/token quản trị viên. Điểm cuối này yêu cầu giá trị khớp chính xác
với:

```http
X-Sync-Secret: <SYNC_SHARED_SECRET>
```

Việc so sánh diễn ra trong thời gian không đổi. Nếu chưa cấu hình bí mật, điểm
cuối trả 503. CORS cross-origin không cho phép `X-Sync-Secret`, vì vậy ứng dụng
khách trên trình duyệt không được gọi trực tiếp tuyến này.

## Giới hạn tốc độ và giới hạn yêu cầu

Bộ giới hạn theo từng tuyến sử dụng **cửa sổ cố định 60 giây cho mỗi IP khách và
phạm vi tuyến**. Chúng chỉ tồn tại trong từng tiến trình và được đặt lại khi khởi
động lại. Khi `TRUST_PROXY_HEADERS=true` (mặc định), khóa giới hạn là mục cuối
cùng trong `X-Forwarded-For` được phân tách bằng dấu phẩy; edge tin cậy phải nối
thêm địa chỉ peer thực tế. Nếu không, địa chỉ peer của socket được sử dụng.

| Phạm vi | Giới hạn |
| --- | --- |
| `login` | 5 yêu cầu/phút/IP |
| `refresh` | 10 yêu cầu/phút/IP |
| `contribution_create` | 10 yêu cầu/phút/IP |
| `feature_delete` | 20 yêu cầu/phút/IP |
| `contribution_approve` | 30 yêu cầu/phút/IP |
| `contribution_reject` | 30 yêu cầu/phút/IP |
| `sos_create` | 20 yêu cầu/phút/IP |
| `sos_ack` | 30 yêu cầu/phút/IP |
| `sos_resolve` | 30 yêu cầu/phút/IP |

Vượt quá giới hạn của một phạm vi trả **429** kèm:

```json
{"detail":"Rate limit exceeded"}
```

Triển khai hiện tại **không** phát `Retry-After`. Các điểm cuối không có bộ giới
hạn riêng vẫn chịu giới hạn toàn cục về kích thước thân yêu cầu và thời gian chờ
yêu cầu; không được giả định rằng chúng có năng lực production không giới hạn.

## Lỗi và mã trạng thái

Lỗi từ handler sử dụng định dạng tương thích với FastAPI:

```json
{"detail":"Feature not found"}
```

Lỗi phân tích JSON và lỗi kiểm tra model trả **422** kèm mảng theo kiểu Pydantic:

```json
{
  "detail": [
    {
      "loc": ["body", "geometry"],
      "msg": "geometry must contain type and coordinates",
      "type": "value_error"
    }
  ]
}
```

Thân JSON không hợp lệ có `loc: ["body"]` và `type: "value_error.json"`. JSON
extractor cũng báo các trường model bắt buộc nhưng bị thiếu dưới dạng 422.

Các mã trạng thái thường gặp:

| Trạng thái | Ý nghĩa |
| --- | --- |
| 200 | Phản hồi JSON thành công, tải xuống CSV hoặc tile bản đồ |
| 400 | Giá trị đường dẫn/truy vấn không hợp lệ bị Axum từ chối |
| 401 | Thông tin xác thực không hợp lệ/hết hạn, sai loại token hoặc bí mật đồng bộ không hợp lệ |
| 403 | Thiếu hoặc sai định dạng thông tin xác thực Bearer |
| 404 | Không tìm thấy tài nguyên hoặc không có tuyến này |
| 405 | Phương thức không được phép đối với tuyến đã biết |
| 408 | Hết thời gian chờ cho toàn bộ yêu cầu |
| 413 | Thân yêu cầu vượt quá `BODY_LIMIT_BYTES` |
| 422 | JSON không hợp lệ hoặc kiểm tra model/domain thất bại |
| 429 | Vượt quá giới hạn tốc độ theo cửa sổ cố định của tuyến |
| 500 | Lỗi storage hoặc lỗi yêu cầu upstream |
| 503 | Chưa cấu hình tích hợp tùy chọn bắt buộc, chẳng hạn xác nhận đồng bộ hoặc tile VietMap |

Lỗi storage cố tình được trả về ở mức chung (`Storage backend request failed`) và
không làm lộ chi tiết phụ thuộc.

## Danh mục điểm cuối

| Phương thức | Đường dẫn | Xác thực | Giới hạn tuyến |
| --- | --- | --- | --- |
| GET | `/health` | Ẩn danh | — |
| GET | `/ready` | Ẩn danh | — |
| GET | `/api/health` | Ẩn danh | — |
| GET | `/api/ready` | Ẩn danh | — |
| POST | `/api/auth/login` | Thông tin quản trị viên trong body | 5/phút |
| POST | `/api/auth/refresh` | Refresh token trong body | 10/phút |
| GET | `/api/features` | Ẩn danh | — |
| POST | `/api/features` | Bearer | — |
| DELETE | `/api/features/{feature_id}` | Bearer | 20/phút |
| POST | `/api/contributions` | Ẩn danh | 10/phút |
| GET | `/api/contributions` | Bearer | — |
| POST | `/api/contributions/{contribution_id}/approve` | Bearer | 30/phút |
| DELETE | `/api/contributions/{contribution_id}` | Bearer | 30/phút |
| GET | `/api/leaderboard` | Ẩn danh | — |
| POST | `/api/sos` | Ẩn danh | 20/phút |
| GET | `/api/sos` | Bearer | — |
| POST | `/api/sos/{report_id}/ack` | Bearer | 30/phút |
| POST | `/api/sos/{report_id}/resolve` | Bearer | 30/phút |
| POST | `/api/sync/ack` | `X-Sync-Secret` | — |
| GET | `/api/export_csv` | Ẩn danh | — |
| GET | `/api/map/tiles/{z}/{x}/{y}` | Ẩn danh | — |
| GET | `/api/map/config` | Ẩn danh | — |

## Tình trạng hoạt động và sẵn sàng

### GET `/health` và GET `/api/health`

Điểm kiểm tra liveness ẩn danh. Luôn trả 200 mà không liên hệ storage.

```json
{
  "status": "ok",
  "service": "contribution-backend",
  "version": "0.1.0"
}
```

`version` là phiên bản crate đã biên dịch.

### GET `/ready` và GET `/api/ready`

Phản hồi sẵn sàng ẩn danh. Trả 200 và xác định storage backend đã cấu hình; không
thực hiện kiểm tra trực tiếp phụ thuộc đang hoạt động.

```json
{
  "status": "ready",
  "service": "contribution-backend",
  "version": "0.1.0",
  "storage": "dx"
}
```

`storage` là `"dx"` trong production. `"base"` là backend Tier-1 cũ dùng cho
migration/rollback; `"json"` chỉ được phép trong môi trường phát triển.

## Điểm cuối xác thực

### POST `/api/auth/login`

Giới hạn tốc độ: **5/phút/IP**. Thân yêu cầu:

| Trường | Kiểu | Bắt buộc | Ghi chú |
| --- | --- | --- | --- |
| `username` | string | Có | Được so sánh với `ADMIN_USERNAME` |
| `password` | string | Có | Được so sánh trong thời gian không đổi với `ADMIN_PASSWORD` |

```json
{"username":"admin","password":"<configured-password>"}
```

Thành công (200):

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "token_type": "bearer"
}
```

Thông tin xác thực không đúng trả 401 kèm
`{"detail":"Incorrect username or password"}`. Thiếu trường hoặc JSON không hợp
lệ trả 422. Vượt quá giới hạn trả 429.

### POST `/api/auth/refresh`

Giới hạn tốc độ: **10/phút/IP**. Thân yêu cầu:

| Trường | Kiểu | Bắt buộc | Ghi chú |
| --- | --- | --- | --- |
| `refresh_token` | string | Có | Phải là JWT hợp lệ, chưa hết hạn có `type: "refresh"` |

```json
{"refresh_token":"<refresh-jwt>"}
```

Phản hồi thành công (200) có cùng cấu trúc như đăng nhập và chứa access token
cùng refresh token mới được phát hành. Token không hợp lệ/đã hết hạn trả 401 kèm
`{"detail":"Could not validate credentials"}`; nếu cung cấp access token tại đây
thì trả 401 kèm `{"detail":"Invalid token type"}`. Thiếu/không hợp lệ trường trả
422; vượt quá giới hạn trả 429.

## Feature hạ tầng

Feature là các đối tượng tương tự GeoJSON trong dataset Tier-2
`city-contribution-features`.

### GET `/api/features`

Ẩn danh. Không có tham số truy vấn hay phân trang. Trả về tất cả feature đã lưu:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "feature-1",
      "_id": "feature-1",
      "feature_code": "den_duong",
      "properties": {
        "feature_type": "Đèn đường",
        "name": "Street light"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [106.7, 10.7]
      },
      "created_at": "2026-11-26T10:20:30.123456+00:00",
      "city_synced": false
    }
  ]
}
```

Các trường chung là `type`, `id`, `properties` và `geometry`. Các trường do
storage thêm vào là `_id`, `created_at` và `city_synced`; chúng không được bảo
đảm giống hệt nhau giữa production Base backend và development JSON backend.
`feature_code`, `source_submission_id` và các trường bổ sung từ bản gửi đã duyệt
cũng có thể xuất hiện.

### POST `/api/features`

Yêu cầu Bearer. Không có giới hạn tốc độ riêng cho tuyến. Thân yêu cầu:

| Trường | Kiểu | Bắt buộc | Mặc định/kiểm tra |
| --- | --- | --- | --- |
| `type` | string | Không | `"Feature"`; cắt khoảng trắng và làm sạch HTML |
| `id` | string | Không | Lưu đúng như được cung cấp; được tạo tự động khi bỏ qua |
| `feature_code` | string | Không | Cắt khoảng trắng, làm sạch HTML và bỏ qua khi rỗng |
| `properties` | object | Có | Các chuỗi được làm sạch HTML theo đệ quy |
| `geometry` | object | Có | Dùng kiểm tra hình học có giới hạn chung bên dưới |

Khi không có `feature_code` hoặc `feature_code` rỗng, storage suy ra giá trị này
từ `properties.feature_type` bằng cách chuyển thành chữ thường và thay dấu cách
bằng dấu gạch dưới. Storage production cũng thêm thời điểm tạo và
`city_synced: false`.

Thành công (200):

```json
{"status":"success"}
```

Phản hồi không chứa ID vừa tạo; hãy đọc `GET /api/features` để lấy ID đó. Lỗi kiểm
tra trả 422.

### DELETE `/api/features/{feature_id}`

Yêu cầu Bearer. Giới hạn tốc độ: **20/phút/IP**. Không có thân yêu cầu. Xóa
feature có ID mờ khớp chính xác.

Thành công (200):

```json
{
  "status": "success",
  "message": "Feature feature-1 deleted"
}
```

ID không tồn tại trả 404 kèm `{"detail":"Feature not found"}`.

## Contribution và kiểm duyệt

### POST `/api/contributions`

Bản gửi từ công dân, không yêu cầu xác thực. Giới hạn tốc độ:
**10/phút/IP**. Thân yêu cầu:

| Trường | Kiểu | Bắt buộc | Mặc định/kiểm tra |
| --- | --- | --- | --- |
| `contributor_name` | string | Có điều kiện | Bắt buộc cùng `msv` trừ khi ẩn danh; tối đa 100 ký tự sau khi cắt khoảng trắng/làm sạch |
| `msv` | string | Có điều kiện | Bắt buộc cùng `contributor_name` trừ khi ẩn danh; tối đa 20 ký tự |
| `unit` | string | Không | Cắt khoảng trắng/làm sạch; rỗng hoặc bỏ qua sẽ trở thành `"VKU"` |
| `anonymous` | boolean | Không | `false`; khi true, danh tính được thay bằng giá trị ẩn danh |
| `properties` | object | Có | Được làm sạch theo đệ quy; kích thước sau khi serialize theo kiểu Python không vượt quá 10.000 ký tự |
| `geometry` | object | Có | Dùng kiểm tra hình học có giới hạn chung bên dưới |

Nếu bỏ qua cả `contributor_name` và `msv`, contribution được coi là ẩn danh ngay
cả khi `anonymous` là false. Nếu `anonymous` là true, danh tính được lưu luôn là
`contributor_name: "Ẩn danh"`, `msv: "ANON"` và `unit: "Ẩn danh"`. Nếu không, cả
hai trường danh tính đều bắt buộc. Các trường văn bản bị xóa thẻ HTML và được
escape entity.

```json
{
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "anonymous": false,
  "properties": {
    "feature_type": "Đèn đường",
    "name": "Street light"
  },
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  }
}
```

Thành công (200):

```json
{
  "status": "success",
  "message": "Contribution submitted"
}
```

Bản gửi được lưu với `status: "pending"` và không xuất hiện trên bảng xếp hạng
cho đến khi được duyệt. Lỗi kiểm tra trả 422; vượt quá giới hạn trả 429.

### GET `/api/contributions`

Yêu cầu Bearer. Không có tham số truy vấn hay giới hạn tốc độ riêng cho tuyến.
Chỉ trả về các bản gửi đang chờ dưới dạng mảng JSON. Storage production sắp xếp
chúng theo `timestamp` giảm dần.

Mỗi mục thường chứa:

```json
{
  "id": "c1",
  "_id": "c1",
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "anonymous": false,
  "properties": {
    "feature_type": "Đèn đường",
    "name": "Street light"
  },
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  },
  "status": "pending",
  "timestamp": "2026-11-26T10:20:30.123456",
  "type": "Feature",
  "feature_code": "đèn_đường"
}
```

`feature_code` được thêm vào khi `properties.feature_type` là chuỗi không rỗng.
`_id` và `created_at` là trường bổ sung của Base storage; development JSON
backend không thêm mọi trường metadata production.

### POST `/api/contributions/{contribution_id}/approve`

Yêu cầu Bearer. Giới hạn tốc độ: **30/phút/IP**. Không yêu cầu thân yêu cầu.
Việc duyệt một bản gửi đang chờ sẽ tạo ra feature và đánh dấu bản gửi là đã
duyệt. Feature nhận `id: "feature-<contribution_id>"` và
`source_submission_id` để việc thử lại không thể tạo bản sao.

Thành công (200):

```json
{"status":"success"}
```

Việc thử lại một bản gửi đã duyệt là thao tác thành công idempotent:

```json
{"status":"success","idempotent":true}
```

Bản gửi không tồn tại hoặc không còn ở trạng thái chờ trả 404 kèm
`{"detail":"Contribution not found"}` (bản gửi đã duyệt là ngoại lệ idempotent
nêu trên).

### DELETE `/api/contributions/{contribution_id}`

Yêu cầu Bearer. Giới hạn tốc độ: **30/phút/IP**. Không có thân yêu cầu. Từ chối/
xóa bản gửi, bất kể trạng thái hiện tại.

Thành công (200):

```json
{"status":"success"}
```

ID không tồn tại trả 404 kèm `{"detail":"Contribution not found"}`.

## Bảng xếp hạng

### GET `/api/leaderboard`

Ẩn danh. Không có tham số truy vấn, phân trang hay giới hạn tốc độ riêng cho
tuyến. Trả về mảng JSON được sắp xếp theo:

1. `count` giảm dần;
2. `contributor_name` tăng dần khi số lượng bằng nhau.

Chỉ các bản gửi **đã duyệt, không ẩn danh** được tính. Các dòng được nhóm theo
`msv`; các bản gửi đang chờ/bị từ chối và contribution ẩn danh bị loại trừ.
`unit` là giá trị tổ chức được lưu cho người đóng góp trong nhóm, mặc định là
`"VKU"` khi bản ghi đã lưu không có unit.

#### Schema phản hồi

Phản hồi là mảng, không phải đối tượng. Mỗi dòng có đúng các trường bảng xếp
hạng công khai sau:

| Trường | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `contributor_name` | string | Tên hiển thị của người đóng góp |
| `msv` | string | Mã định danh người đóng góp/sinh viên và khóa nhóm |
| `unit` | string | Tổ chức/đơn vị; `"VKU"` là giá trị dự phòng |
| `count` | integer | Số bản gửi đã duyệt, không ẩn danh của `msv` đó |

Ví dụ:

```json
[
  {
    "contributor_name": "Nguyen Van A",
    "msv": "23AI034",
    "unit": "VKU",
    "count": 12
  },
  {
    "contributor_name": "Tran Thi B",
    "msv": "23AI035",
    "unit": "UIT",
    "count": 9
  },
  {
    "contributor_name": "Le Van C",
    "msv": "23AI036",
    "unit": "VKU",
    "count": 4
  }
]
```

Bảng xếp hạng rỗng là `[]`.

#### Lọc tổ chức ở phía client

**API hiện trả về tất cả tổ chức và không chấp nhận tham số truy vấn `unit` hay
tham số truy vấn tổ chức.** Console đóng góp tải toàn bộ mảng này một lần, suy ra
các tổ chức có trong phản hồi và lọc theo `leader.unit` đã chọn trong trình
duyệt. Unit bị thiếu/rỗng dùng giá trị dự phòng `VKU`. Tùy chọn “Tất cả tổ chức”
của UI hiển thị toàn bộ mảng.

Sau khi lọc, UI tính lại ba hạng đầu hiển thị và gán thứ hạng trong bảng bắt đầu
từ 1 trong phạm vi tổ chức đã chọn. Đây là hoạt động lọc chỉ để trình bày: không
thay đổi số lượng, không nhóm lại người đóng góp và không thay đổi phản hồi/hợp
đồng API của backend.

## Tiếp nhận SOS cũ từ công dân

Các tuyến này chỉ giới hạn ở việc thu thập báo cáo công khai và cập nhật trạng
thái bởi quản trị viên. Chúng không điều phối người ứng cứu và không cung cấp dữ
liệu nghiệp vụ khẩn cấp.

### POST `/api/sos`

Ẩn danh. Giới hạn tốc độ: **20/phút/IP**. Thân yêu cầu:

| Trường | Kiểu | Bắt buộc | Kiểm tra |
| --- | --- | --- | --- |
| `contributor_name` | string | Có | 1–100 ký tự sau khi cắt khoảng trắng/làm sạch |
| `msv` | string | Có | 1–20 ký tự |
| `unit` | string | Không | Cắt khoảng trắng/làm sạch; rỗng/bỏ qua sẽ trở thành `"VKU"` |
| `emergency_type` | string | Có | 2–50 ký tự; không hạn chế enum |
| `severity` | string | Có | Chuyển thành chữ thường; một trong `low`, `medium`, `high`, `critical` |
| `message` | string | Có | 5–2.000 ký tự |
| `district` | string | Không | Tối đa 120 ký tự |
| `ward` | string | Không | Tối đa 120 ký tự |
| `contact_phone` | string | Không | Tối đa 30 ký tự |
| `geometry` | object | Không | Phải chứa `type` dạng string và `coordinates` dạng mảng; kích thước sau khi serialize tối đa 5.000 ký tự |

Khác với geometry của contribution/feature, geometry SOS chỉ được kiểm tra hình
dạng và giới hạn kích thước; tuyến này không áp dụng giới hạn tọa độ cho
Point/LineString/Polygon. Các trường tùy chọn bị bỏ qua khỏi storage khi không
được cung cấp.

```json
{
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "emergency_type": "fire",
  "severity": "HIGH",
  "message": "Smoke near the market",
  "district": "Quan 1",
  "ward": "Ben Nghe",
  "contact_phone": "0900000000",
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  }
}
```

Thành công (200):

```json
{
  "status": "success",
  "message": "SOS report submitted"
}
```

Báo cáo được lưu bắt đầu ở `status: "pending"`, có `source: "datacollector"` và
nhận timestamp `created_at`/`updated_at`. Lỗi kiểm tra trả 422; vượt quá giới hạn
trả 429.

### GET `/api/sos`

Yêu cầu Bearer. Không có giới hạn tốc độ riêng cho tuyến. Tham số truy vấn tùy
chọn:

| Tham số | Kiểu | Bắt buộc | Ý nghĩa |
| --- | --- | --- | --- |
| `status` | string | Không | Bộ lọc trạng thái khớp chính xác, ví dụ `pending`, `acknowledged` hoặc `resolved` |

Trả về mảng JSON được sắp xếp theo `created_at` giảm dần. Nếu không có `status`,
tất cả báo cáo được trả về. Dịch vụ không kiểm tra `status` theo enum; giá trị
không xác định chỉ đơn giản là không khớp với bản ghi nào.

Mỗi mục chứa `id`, `contributor_name`, `msv`, `unit`, `emergency_type`,
`severity`, `message`, `status`, `created_at`, `updated_at` và
`source: "datacollector"`. Các trường tùy chọn `district`, `ward`, `contact_phone`
và `geometry` chỉ xuất hiện khi được cung cấp. Base storage cũng có `_id`.

### POST `/api/sos/{report_id}/ack`

Yêu cầu Bearer. Giới hạn tốc độ: **30/phút/IP**. Không có thân yêu cầu. Đặt
`status: "acknowledged"` và cập nhật `updated_at`.

Thành công (200): `{"status":"success"}`. ID không tồn tại trả 404 kèm
`{"detail":"SOS report not found"}`.

### POST `/api/sos/{report_id}/resolve`

Yêu cầu Bearer. Giới hạn tốc độ: **30/phút/IP**. Không có thân yêu cầu. Đặt
`status: "resolved"` và cập nhật `updated_at`.

Thành công (200): `{"status":"success"}`. ID không tồn tại trả 404 kèm
`{"detail":"SOS report not found"}`. Handler không bắt buộc phải chuyển từ
trạng thái acknowledged sang resolved.

## Xác nhận xuất dữ liệu hằng ngày nội bộ

### POST `/api/sync/ack`

Yêu cầu `X-Sync-Secret`; không chấp nhận Bearer token thay thế. Không có giới hạn
tốc độ riêng cho tuyến. Thân yêu cầu có thể rỗng hoặc là JSON:

| Trường | Kiểu | Bắt buộc | Mặc định/kiểm tra |
| --- | --- | --- | --- |
| `limit` | `number` hoặc chuỗi số | Không | Mặc định `500`; được giới hạn trong khoảng `1..1000` |

```http
X-Sync-Secret: <configured-secret>
Content-Type: application/json
```

```json
{"limit":500}
```

JSON không hợp lệ được coi như đối tượng rỗng, vì vậy giới hạn mặc định được áp
dụng. Handler đánh dấu tối đa `limit` feature chưa đồng bộ bằng
`city_synced: true` và timestamp `city_synced_at`.

Thành công (200):

```json
{"status":"success","marked":12}
```

`marked` là số bản ghi được cập nhật thành công. Bí mật bị thiếu/không hợp lệ trả
401 kèm `{"detail":"Invalid sync secret"}`. Nếu chưa cấu hình
`SYNC_SHARED_SECRET`, trả 503 kèm
`{"detail":"Sync acknowledgement is not configured"}`.

## Xuất CSV

### GET `/api/export_csv`

Ẩn danh. Không có giới hạn tốc độ riêng cho tuyến. Tham số truy vấn tùy chọn:

| Tham số | Kiểu | Bắt buộc | Ý nghĩa |
| --- | --- | --- | --- |
| `types` | string | Không | Các mã feature hoặc kiểu feature tiếng Việt, phân tách bằng dấu phẩy |

Các giá trị được loại trùng, xóa dấu tiếng Việt, đổi `đ/Đ` thành `d/D` và đổi
dấu cách thành dấu gạch dưới để so sánh. Một feature khớp khi `feature_code`
hoặc `properties.feature_type` sau khi chuẩn hóa bằng với một giá trị được yêu
cầu. Bỏ qua `types` sẽ xuất tất cả feature; nếu có `types` nhưng giá trị rỗng/
chỉ chứa khoảng trắng thì không xuất dòng dữ liệu nào (CSV vẫn chứa header).

Các giá trị dự phòng có sẵn cho kiểu hiển thị khi không có `feature_code`:

| Kiểu feature | Mã |
| --- | --- |
| Trạm điện | `tram_dien` |
| Cột điện | `cot_dien` |
| Đường ống điện | `duong_ong_dien` |
| Đèn đường | `den_duong` |
| Đèn giao thông | `den_giao_thong` |
| Cống thoát nước | `cong_thoat_nuoc` |
| Ống dẫn nước | `ong_dan_nuoc` |
| Trụ chữa cháy | `tru_chua_chay` |
| Trạm sạc | `tram_sac` |

Thành công (200) là CSV có thể tải xuống, không phải JSON:

```http
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename=features.csv
```

Tệp có một UTF-8 BOM và dùng kết thúc dòng CRLF. Các cột đầu tiên là
`feature_type`, `feature_code` và `geometry`; các cột còn lại là hợp của các khóa
property của feature, được sắp xếp. Geometry là văn bản kiểu WKT viết hoa, chẳng
hạn `POINT [106.7, 10.7]`. Giá trị property có thể ghi đè ba cột cơ sở. Boolean
hiển thị là `True`/`False`, null là ô trống và các giá trị lồng nhau dùng cách
biểu diễn kiểu Python. Các ô bắt đầu bằng `=`, `+`, `-` hoặc `@` được thêm dấu
nháy đơn ở đầu để ngăn chèn công thức bảng tính.

## Cấu hình bản đồ và tile

### GET `/api/map/config`

Ẩn danh. Không có tham số hay giới hạn riêng cho tuyến. Trả về cấu hình tile cho
trình duyệt. Khi đã cấu hình `VIETMAP_API_KEY`:

```json
{
  "tileUrl": "/api/map/tiles/{z}/{x}/{y}",
  "attribution": "&copy; <a href=\"https://vietmap.vn\">VietMap</a> | Hoang Sa and Truong Sa belong to Vietnam 🇻🇳",
  "maxZoom": 20,
  "provider": "vietmap"
}
```

Khi không có khóa VietMap:

```json
{
  "tileUrl": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  "attribution": "&copy; <a href=\"https://openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
  "maxZoom": 20,
  "provider": "osm"
}
```

### GET `/api/map/tiles/{z}/{x}/{y}`

Ẩn danh. Không có giới hạn riêng cho tuyến. Các tham số đường dẫn `z`, `x` và
`y` là số nguyên signed 32-bit. Điểm cuối yêu cầu `VIETMAP_API_KEY`; điểm cuối
không được dùng khi `/api/map/config` chọn OSM.

Khi thành công, trả 200 với content type của ảnh upstream (dùng `image/png` nếu
không có), `Cache-Control: public, max-age=86400` và
`Access-Control-Allow-Origin: *`. Dịch vụ yêu cầu tile `@2x` của VietMap và giữ
API key ở phía server.

Nếu chưa cấu hình khóa, trả 503 kèm
`{"detail":"VietMap API key not configured"}`. Mã trạng thái HTTP không thành
công từ upstream được chuyển tiếp kèm `{"detail":"Upstream tile error"}`. Lỗi mạng
hoặc lỗi thân phản hồi upstream trả 500 với cùng thông điệp chi tiết. Yêu cầu
tile upstream có thời gian chờ 15 giây ngoài thời gian chờ toàn cục của yêu cầu.

## Kiểm tra hình học có giới hạn chung

`POST /api/features` và `POST /api/contributions` dùng các quy tắc hình học sau:

- Giá trị phải là đối tượng có `type` dạng string và `coordinates` dạng mảng.
- Các kiểu được phép: `Point`, `LineString`, `Polygon`.
- Mỗi position là mảng `[longitude, latitude]` (kinh độ, vĩ độ) với giá trị độ
  cao hữu hạn tùy chọn ở vị trí thứ ba.
- Kinh độ phải hữu hạn và nằm trong `[-180, 180]`; vĩ độ phải hữu hạn và nằm
  trong `[-90, 90]`.
- `Point` có một position; `LineString` có ít nhất hai; `Polygon` có ít nhất một
  ring và mỗi ring có ít nhất bốn position.
- Một geometry có tối đa 2.000 position tổng cộng và tối đa 16.000 ký tự sau khi
  serialize.
- Không kiểm tra riêng việc đóng ring. Các kiểu geometry không được hỗ trợ như
  `MultiPoint` và `GeometryCollection` trả 422.

## CORS

Các origin CORS đến từ `CORS_ORIGINS` (mặc định
`https://contribution.synapsecity.sbs`). Dịch vụ cho phép `GET`, `POST`, `PUT`,
`PATCH`, `DELETE` và `OPTIONS`, credentials cùng các header yêu cầu
`Authorization`, `Content-Type` và `X-Requested-With`. Chỉ các origin đã cấu hình
được phép. `X-Sync-Secret` cố tình không nằm trong allowlist CORS của trình duyệt.

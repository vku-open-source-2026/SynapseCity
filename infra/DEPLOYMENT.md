# Public deployment

The stack has three containers on the private `synapsecity-public-stack`
network:

| Service | Container port | Host port | Public route |
| --- | --- | --- | --- |
| `gateway` | `8080` | `${GATEWAY_HOST_PORT:-8085}` | `https://synapsecity.sbs/health`, `/ready`, `/v1/*` |
| `city-service` | `8083` | not published | internal only |
| `console` | `80` | not published | `https://synapsecity.sbs/` and `cloud.synapsecity.sbs` |

The gateway always listens on container port `8080`; the TLS edge and the
compose console proxy target that port. The default host port is `8085` so it
can never be confused with the private `city-service` port `8083`. Override
`GATEWAY_HOST_PORT` when another local stack already uses `8085`.

After starting the stack, connect the existing public edge to the network and
include `nginx/synapsecity.conf`:

```bash
docker network connect synapsecity-public-stack synapseone-nginx-1
```

Issue a certificate containing `synapsecity.sbs` (and the optional
`cloud.synapsecity.sbs`) before enabling the TLS server block. The DNS A/AAAA
records must point to this host. Configure `SYNAPSEDX_API_KEY` in `.env` so
private domain writes can be authorized by SynapseDX; public reads still use
the public projection endpoint.

The public API is `https://synapsecity.sbs`. Production configuration must not
use `localhost` or a private service address for `SYNAPSEDX_BASE_URL`; the
compose file forces `https://synapsedx.sbs` and
`ALLOW_LOCAL_DEPENDENCIES=false`.

Authentication uses a stateless HMAC-SHA256 session shell in `city-service`.
Set `AUTH_SECRET` in `.env` so sessions survive a restart; if it is unset the
service generates an ephemeral secret and logs a warning. The shell never stores
or validates passwords — production identity must be delegated to the Tier-1
IAM service.

The console is served through the gateway's console proxy for local
single-port access, and directly by the edge at the domain root in production.
In both cases the console's relative `/v1` calls stay on the gateway, so the
console proxy remains functional.

The edge configuration is a deployment operation because the current
SynapseOne edge certificate only covers `synapseone.space` and its existing
subdomains.

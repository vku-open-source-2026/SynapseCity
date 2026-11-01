# Public deployment

The stack has three containers: `city-service` (domain backend), `gateway`
(public API), and `console` (frontend). The gateway is published on host port
`8083`. The domain backend calls the Tier-2 gateway only at
`https://synapsedx.sbs`.

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

The edge configuration is a deployment operation because the current
SynapseOne edge certificate only covers `synapseone.space` and its existing
subdomains.

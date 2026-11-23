# Third-party notices

This project is **adapted from** [anheon/dsh-connect-codearts](https://github.com/anheon/dsh-connect-codearts)
(MIT License). It is a port to the pi coding agent, not a git fork.

## dsh-connect-codearts

- Source: https://github.com/anheon/dsh-connect-codearts (v0.1.6, commit ded7a7e, 2026-11-23)
- License: MIT — Copyright (c) 2026 dsh-connect-codearts contributors (see `vendor/dsh-connect-codearts/LICENSE`)
- Files copied verbatim, unmodified:
  - `src/protocol/types.ts`, `sign.ts`, `body.ts`, `sse.ts`, `errors.ts`
  - `src/upstream.ts`
  - `PROTOCOL.md`
- Used for: `SDK-HMAC-SHA256` request signing, request-body normalization rules, SSE parsing, error
  classification, and the clients for model catalog / thinking variants / credits / welfare endpoints.
- The comments in those files cite their own upstream references (all MIT): XLNC-L/dsh-connect-madao
  (https://github.com/XLNC-L/dsh-connect-madao) and Alanine-孔硕's dsh-huaweicloud-connect.

## HITZY2002/codearts2api

- Source: https://github.com/HITZY2002/codearts2api (MIT)
- Used for: the `/v1/ops/confirm` endpoint path and body for the check-in confirm step
  (`docs/reverse-engineering.md` §6). No code was copied.

## @earendil-works/pi-ai, @earendil-works/pi-coding-agent

- Source: https://github.com/earendil-works/pi (installed globally on the host machine)
- Loaded at runtime through pi's extension loader; not bundled.

# CLAUDE.md – fotospel

Taal: **Nederlands**.

## Werkwijze
Volg `WORKFLOW.md` en `skills/dev-workflow/SKILL.md` uit [flyingwing1994/.github](https://github.com/flyingwing1994/.github): elke wijziging via issue → branch → PR, nooit rechtstreeks naar `main`, Claude merget nooit zelf. Checks en review staan in `.github/workflows/pr.yml`.

## Deze repo
- Node.js 22 zonder externe pakketten (`node:sqlite`); `server.js`, `lib/`, beheerscript `scripts/admin.js`.
- Tests: `npm test` (`node --test`, e2e). Tests zijn verplicht.
- Draait in Docker op lxc-docker (CT 102, poort 3000) achter een Cloudflare Tunnel; `docker-build` staat aan in de checks. Data in `./data`.
- Geheimen alleen in `.env`, nooit in git.

# Fotospel

Webapp voor een eendaags fotospel: teams, dichte kaartjes per ronde, klok per team, één foto per opdracht,
beoordeling door beheerders, live scorebord en een feed na de onthulling.

- Spelers: `https://fotospel.palmkool.nl/` (teamcode + naam)
- Beheer: `https://fotospel.palmkool.nl/beheer`

Node.js 22 zonder externe pakketten (ingebouwde `node:sqlite`). Data (database + foto's) staat in `./data`.

## Draaien

```sh
mkdir -p data && chown 1000:1000 data
cp .env.example .env        # TUNNEL_TOKEN invullen
docker compose up -d --build
docker compose exec fotospel node --no-warnings scripts/admin.js add <naam>   # print het wachtwoord
```

Beheerders: `scripts/admin.js add|passwd|remove|list <naam> [wachtwoord]`.

## Testen

```sh
node --no-warnings --test test/e2e.test.js   # puntentelling + compleet spel via de API
node --no-warnings test/visual.js <map>      # schermafbeeldingen met headless Chrome
```

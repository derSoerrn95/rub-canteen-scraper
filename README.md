# RUB Mensa Scraper

Daily automation that mirrors the weekly menus of the three RUB cafeterias (Mensa, Q-West, Rote Beete) from the official AKAFÖ website into JSON snapshots kept in this repository.

Official AKAFÖ menu pages:
- Ruhr-Universität Bochum Mensa: https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/ruhr-universitaet-bochum/
- Q-West: https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/q-west/
- Rote Beete: https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/rote-bete/

## Requirements
- [Bun](https://bun.sh/) ≥ 1.0 (includes TypeScript runtime and package manager)

Install dependencies once:
```bash
bun install
```

## Fetching Menus Locally
Run the scraper to grab the current data set:
```bash
bun run fetch:menus
```
The script scrapes akafoe.de, normalises meals, and writes two complementary outputs for each ISO week:
- `data/menus/<year>-W<week>.json` — grouped by canteen (`canteens` map).
- `data/menus/by-day/<year>-W<week>.json` — grouped by calendar day (`days` map).

Each entry contains meal categories, cleaned allergen lists, parsed price tiers, and the legend published on the source site (info, allergens, additives).

### Useful `jq` Snippets
Menu for today (all canteens) from a local checkout:
```bash
today=$(date +%F)
week=$(date +%G-W%V)
jq --arg day "$today" '.days[$day]' "data/menus/by-day/${week}.json"
```
or with `cat`
```bash
today=$(date +%F)
week=$(date +%G-W%V)
cat data/menus/by-day/${week}.json | jq --arg day "$today" '.days[$day]'
```
Menu for today pulled straight from the default branch on GitHub:
```bash
today=$(date +%F)
week=$(date +%G-W%V)
curl -s "https://raw.githubusercontent.com/derSoerrn95/rub-canteen-scraper/refs/heads/main/data/menus/by-day/${week}.json" \
  | jq --arg day "$today" '.days[$day]'
```
Menu for a specific canteen on a specific day:
```bash
curl -s "https://raw.githubusercontent.com/derSoerrn95/rub-canteen-scraper/refs/heads/main/data/menus/2025-W43.json" | jq '.canteens["main"].days["2025-10-20"]'
```

## CI Automation
A GitHub Action (`.github/workflows/fetch-menus.yml`) runs every morning, installs dependencies, executes the scraper, and commits any new or updated JSON snapshots back to the repository.

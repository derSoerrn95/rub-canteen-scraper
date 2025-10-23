#!/usr/bin/env bun

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

import type {Cheerio, CheerioAPI} from "cheerio";
import {load} from "cheerio";

type Element = any;

const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
    "rub-mensa-scraper/1.0 (+https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/)";

interface CanteenConfig {
    readonly slug: string;
    readonly name: string;
    readonly url: string;
}

interface MealPrice {
    readonly raw: string;
    readonly currency: "EUR";
    readonly values: number[];
    readonly labels: string[];
}

interface MealEntry {
    readonly title: string;
    readonly allergens: string[];
    readonly allergensRaw: string | null;
    readonly price: MealPrice | null;
    readonly highlight: boolean;
}

interface MealCategory {
    readonly title: string;
    readonly meals: MealEntry[];
}

interface DayMenu {
    readonly date: string;
    readonly label: string;
    readonly categories: MealCategory[];
}

interface DayDetails {
    readonly label: string;
    readonly categories: MealCategory[];
}

interface Legend {
    readonly info: Record<string, string>;
    readonly allergens: Record<string, string>;
    readonly additives: Record<string, string>;
}

interface ParsedMenu {
    readonly days: DayMenu[];
    readonly legend: Legend | null;
}

interface WeekPartition {
    isoYear: number;
    isoWeek: number;
    from: string;
    to: string;
    days: DayMenu[];
}

interface OutputWeek {
    readonly week: {
        isoYear: number;
        isoWeek: number;
        from: string;
        to: string;
    };
    generatedAt: string;
    readonly canteens: Record<
        string,
        {
            name: string;
            sourceUrl: string;
            legend: Legend | null;
            days: Record<string, DayDetails>;
        }
    >;
}

interface DayGroupedWeek {
    readonly week: {
        isoYear: number;
        isoWeek: number;
        from: string;
        to: string;
    };
    readonly generatedAt: string;
    readonly days: Record<
        string,
        {
            label: string;
            canteens: Record<
                string,
                {
                    name: string;
                    sourceUrl: string;
                    legend: Legend | null;
                    categories: MealCategory[];
                }
            >;
        }
    >;
}

const CANTEENS: readonly CanteenConfig[] = [
    {
        slug: "main",
        name: "Mensa Ruhr-Universität Bochum",
        url: "https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/ruhr-universitaet-bochum/",
    },
    {
        slug: "q-west",
        name: "Q-West",
        url: "https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/q-west/",
    },
    {
        slug: "rote-beete",
        name: "Rote Beete",
        url: "https://www.akafoe.de/gastronomie/speiseplaene-der-mensen/rote-bete/",
    },
];

class NotFoundError extends Error {
    constructor(readonly url: string) {
        super(`Resource not found: ${url}`);
    }
}

async function fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml",
            },
            signal: controller.signal,
        });

        if (response.status === 404) {
            throw new NotFoundError(url);
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        }

        return await response.text();
    } finally {
        clearTimeout(timeout);
    }
}

function parseMenuPage(html: string): ParsedMenu {
    const $ = load(html);
    const blocks = $(".box-speiseplan .block-space");
    if (blocks.length === 0) {
        throw new Error("Could not locate speiseplan container in page.");
    }

    const dayMenus: DayMenu[] = [];

    blocks.each((_, block) => {
        const $block = $(block);
        const heading = cleanText($block.find("h2").first().text());
        const startDate = extractFirstDate(heading) ?? new Date();

        const dayNodes = $block.find(".week .day").toArray();
        const dishRows = $block.find(".dishes .row.list-dish").toArray();

        if (dayNodes.length !== dishRows.length) {
            console.warn(
                `Warning: day selector count (${dayNodes.length}) does not match dish rows (${dishRows.length}).`,
            );
        }

        let previousDate: Date | null = null;

        for (let index = 0; index < dishRows.length; index += 1) {
            const label = cleanText($(dayNodes[index]).text());
            const resolvedDate = resolveDayDate(label, startDate, previousDate);
            const isoDate = formatIsoDate(resolvedDate);

            const categories = parseDishRow($(dishRows[index]), $);
            dayMenus.push({
                date: isoDate,
                label,
                categories,
            });

            previousDate = resolvedDate;
        }
    });

    return {
        days: dayMenus,
        legend: parseLegend($),
    };
}

function parseLegend($: CheerioAPI): Legend | null {
    const heading = $(".box-speiseplan h3")
        .filter((_, element) => cleanText($(element).text()).toLowerCase().startsWith("erläuterungen"))
        .first();

    if (heading.length === 0) {
        return null;
    }

    const row = heading.nextAll(".row").first();
    if (row.length === 0) {
        return null;
    }

    const columns = row.find(".col-sm-4");
    if (columns.length === 0) {
        return null;
    }

    const infoText = cleanText($(columns.get(0)).text());
    const allergensText = cleanText($(columns.get(1)).text());
    const additivesText = cleanText($(columns.get(2)).text());

    return {
        info: parseLegendEntries(infoText, /\(([A-Z]{1,2})\)\s*([^,]+?)(?:(?:,|\.)\s|$)/g),
        allergens: parseLegendEntries(allergensText, /([a-z]\d?)\)\s*([^,]+?)(?:(?:,|\.)\s|$)/g),
        additives: parseLegendEntries(additivesText, /(\d{1,2})\)\s*([^,]+?)(?:(?:,|\.)\s|$)/g),
    };
}

function parseLegendEntries(text: string, pattern: RegExp): Record<string, string> {
    const entries: Record<string, string> = {};

    const body = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
    const regex = new RegExp(pattern.source, pattern.flags);

    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
        const key = cleanText(match[1]);
        const value = cleanText(match[2]).replace(/\.$/, "");
        if (key) {
            entries[key] = value;
        }
    }

    return entries;
}

function parseDishRow(row: Cheerio<Element>, $: CheerioAPI): MealCategory[] {
    const categories: MealCategory[] = [];

    row.find("> .col-md-6").each((_, column) => {
        const $column = $(column);
        let current: MealCategory | null = null;

        $column.contents().each((__, node) => {
            if (node.type !== "tag") {
                return;
            }
            const element = $(node as Element);
            const tagName = (node as Element).name?.toLowerCase() ?? "";

            if (tagName === "h3") {
                const title = cleanText(element.text());
                current = {title, meals: []};
                categories.push(current);
                return;
            }

            if (element.hasClass("item")) {
                if (!current) {
                    current = {title: "Uncategorized", meals: []};
                    categories.push(current);
                }
                current.meals.push(parseMeal(element));
            }
        });
    });

    return categories.filter((category) => category.meals.length > 0);
}

function parseMeal(item: Cheerio<Element>): MealEntry {
    const heading = item.find("h4").first();
    const headingClone = heading.clone();
    headingClone.find("small").remove();
    const title = cleanText(headingClone.text());

    const allergensRaw = cleanText(heading.find("small").text()).replace(/^\(|\)$/g, "");
    const allergens =
        allergensRaw.length > 0
            ? allergensRaw
                .split(",")
                .map((token) => cleanText(token))
                .filter(Boolean)
            : [];

    const priceText = cleanText(item.find(".price").text());
    const priceValues = Array.from(priceText.matchAll(/(\d{1,2},\d{2})/g)).map((match) =>
        parseLocaleNumber(match[1]),
    );

    const price: MealPrice | null =
        priceValues.length > 0
            ? {
                raw: priceText,
                currency: "EUR",
                values: priceValues,
                labels: derivePriceLabels(priceValues.length),
            }
            : null;

    return {
        title,
        allergens,
        allergensRaw: allergensRaw.length > 0 ? allergensRaw : null,
        price,
        highlight: item.hasClass("item-tip"),
    };
}

function derivePriceLabels(count: number): string[] {
    if (count === 2) {
        return ["students", "guests"];
    }
    if (count === 3) {
        return ["students", "staff", "guests"];
    }
    return [];
}

function extractFirstDate(text: string): Date | null {
    const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!match) {
        return null;
    }
    const [, day, month, year] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function resolveDayDate(label: string, startDate: Date, previous: Date | null): Date {
    const match = label.match(/(\d{2})\.(\d{2})\./);
    if (!match) {
        throw new Error(`Unable to parse day label "${label}".`);
    }

    const [, dayToken, monthToken] = match;
    const day = Number(dayToken);
    const month = Number(monthToken);

    let year = previous ? previous.getUTCFullYear() : startDate.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, month - 1, day));

    if (previous && candidate.getTime() < previous.getTime()) {
        year += 1;
        candidate = new Date(Date.UTC(year, month - 1, day));
    }

    if (!previous && candidate.getUTCMonth() !== startDate.getUTCMonth()) {
        const startYear = startDate.getUTCFullYear();
        candidate = new Date(Date.UTC(startYear, month - 1, day));
    }

    return candidate;
}

function formatIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function parseLocaleNumber(value: string): number {
    return Number(value.replace(/\./g, "").replace(",", "."));
}

function cleanText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function groupByWeek(days: DayMenu[]): WeekPartition[] {
    const byWeek = new Map<string, WeekPartition>();

    for (const day of days) {
        const date = new Date(`${day.date}T00:00:00Z`);
        const {year, week} = isoWeek(date);
        const key = weekKey(year, week);

        if (!byWeek.has(key)) {
            byWeek.set(key, {
                isoYear: year,
                isoWeek: week,
                from: day.date,
                to: day.date,
                days: [],
            });
        }

        const partition = byWeek.get(key)!;
        partition.days.push(day);
        if (day.date < partition.from) {
            partition.from = day.date;
        }
        if (day.date > partition.to) {
            partition.to = day.date;
        }
    }

    for (const partition of byWeek.values()) {
        partition.days.sort((a, b) => a.date.localeCompare(b.date));
    }

    return Array.from(byWeek.values()).sort((a, b) => {
        if (a.isoYear === b.isoYear) {
            return a.isoWeek - b.isoWeek;
        }
        return a.isoYear - b.isoYear;
    });
}

function convertDaysToMap(days: DayMenu[]): Record<string, DayDetails> {
    const map: Record<string, DayDetails> = {};
    for (const day of days) {
        map[day.date] = {
            label: day.label,
            categories: day.categories,
        };
    }
    return map;
}

function isoWeek(date: Date): { year: number; week: number } {
    const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = temp.getUTCDay() || 7;
    temp.setUTCDate(temp.getUTCDate() + 4 - dayNum);
    const startOfYear = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((temp.getTime() - startOfYear.getTime()) / 86400000 + 1) / 7);
    return {year: temp.getUTCFullYear(), week};
}

function weekKey(year: number, week: number): string {
    return `${year}-W${String(week).padStart(2, "0")}`;
}

function buildDayGroupedWeek(source: OutputWeek): DayGroupedWeek {
    const dayAccumulator: Record<
        string,
        {
            label: string;
            canteens: Record<
                string,
                {
                    name: string;
                    sourceUrl: string;
                    legend: Legend | null;
                    categories: MealCategory[];
                }
            >;
        }
    > = {};

    for (const [slug, canteen] of Object.entries(source.canteens)) {
        for (const [date, day] of Object.entries(canteen.days)) {
            if (!dayAccumulator[date]) {
                dayAccumulator[date] = {label: day.label, canteens: {}};
            }
            dayAccumulator[date].canteens[slug] = {
                name: canteen.name,
                sourceUrl: canteen.sourceUrl,
                legend: canteen.legend,
                categories: day.categories,
            };
        }
    }

    const orderedDays: DayGroupedWeek["days"] = {};
    const orderedDates = Object.keys(dayAccumulator).sort();
    for (const date of orderedDates) {
        const day = dayAccumulator[date];
        const orderedCanteens: Record<
            string,
            {
                name: string;
                sourceUrl: string;
                legend: Legend | null;
                categories: MealCategory[];
            }
        > = {};
        for (const slug of Object.keys(day.canteens).sort()) {
            orderedCanteens[slug] = day.canteens[slug];
        }
        orderedDays[date] = {
            label: day.label,
            canteens: orderedCanteens,
        };
    }

    return {
        week: source.week,
        generatedAt: source.generatedAt,
        days: orderedDays,
    };
}

function writeJsonFile(targetPath: string, payload: unknown): string {
    mkdirSync(dirname(targetPath), {recursive: true});
    const json = JSON.stringify(payload, null, 2) + "\n";

    if (!existsSync(targetPath) || readFileSync(targetPath, "utf8") !== json) {
        writeFileSync(targetPath, json, "utf8");
    }

    return targetPath;
}

async function main(): Promise<void> {
    const outputDir = resolve(process.cwd(), process.env.RUB_MENSA_OUTPUT_DIR ?? "data/menus");
    const generatedAt = new Date().toISOString();

    const aggregated = new Map<string, OutputWeek>();

    for (const canteen of CANTEENS) {
        console.log(`Fetching menus for ${canteen.name} ...`);
        const html = await fetchHtml(canteen.url);
        const parsed = parseMenuPage(html);
        const partitions = groupByWeek(parsed.days);

        for (const partition of partitions) {
            const key = weekKey(partition.isoYear, partition.isoWeek);

            if (!aggregated.has(key)) {
                aggregated.set(key, {
                    week: {
                        isoYear: partition.isoYear,
                        isoWeek: partition.isoWeek,
                        from: partition.from,
                        to: partition.to,
                    },
                    generatedAt,
                    canteens: {},
                });
            }

            const entry = aggregated.get(key)!;
            entry.week.from = entry.week.from < partition.from ? entry.week.from : partition.from;
            entry.week.to = entry.week.to > partition.to ? entry.week.to : partition.to;

            entry.canteens[canteen.slug] = {
                name: canteen.name,
                sourceUrl: canteen.url,
                legend: parsed.legend,
                days: convertDaysToMap(partition.days),
            };
        }
    }

    if (aggregated.size === 0) {
        console.warn("No menu data collected for the configured canteens.");
        return;
    }

    const sortedKeys = Array.from(aggregated.keys()).sort();
    for (const key of sortedKeys) {
        const weekPayload = aggregated.get(key)!;
        const byWeekPath = writeJsonFile(join(outputDir, `${key}.json`), weekPayload);
        console.log(`Wrote ${byWeekPath}`);

        const byDayPayload = buildDayGroupedWeek(weekPayload);
        const byDayPath = writeJsonFile(join(outputDir, "by-day", `${key}.json`), byDayPayload);
        console.log(`Wrote ${byDayPath}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

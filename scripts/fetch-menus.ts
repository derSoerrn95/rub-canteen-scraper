#!/usr/bin/env bun

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "fs";
import {dirname, join, resolve} from "path";

const REQUEST_TIMEOUT_MS = 20_000;
const API_BASE = "https://akafoe.studylife.org/api";
const USER_AGENT = "rub-mensa-scraper/1.0 (+https://github.com)";

interface CanteenConfig {
    readonly slug: string;
    readonly name: string;
    readonly apiId: string;
    readonly sourceUrl: string;
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

interface ApiMeal {
    readonly title: string;
    readonly icons: string[];
    readonly allergens: string[];
    readonly additives: string[];
    readonly price_student: number | null;
    readonly price_employee: number | null;
    readonly price_guest: number | null;
    readonly is_featured: boolean;
    readonly meal_date: string;
    readonly category: {
        readonly name: string;
    };
}

interface ApiDay {
    readonly date: string;
    readonly meals: ApiMeal[];
}

interface ApiWeekResponse {
    readonly week_number: number;
    readonly start_date: string;
    readonly end_date: string;
    readonly days: ApiDay[];
}

const CANTEENS: readonly CanteenConfig[] = [
    {
        slug: "main",
        name: "Mensa Ruhr-Universität Bochum",
        apiId: "a0f40678-5e86-4ae4-9ff1-ae1e9e25934b",
        sourceUrl: "https://www.akafoe.de/essen/mensen-und-cafeterien/speiseplan/Mensa",
    },
    {
        slug: "q-west",
        name: "Q-West",
        apiId: "a0f40678-ac6b-4b31-a37b-7f0e4b5eb188",
        sourceUrl: "https://www.akafoe.de/essen/mensen-und-cafeterien/speiseplan/Q-West%20-%20Mensa",
    },
    {
        slug: "rote-beete",
        name: "Rote Bete",
        apiId: "a0f4067a-78d2-42c2-a3de-1006cf571dea",
        sourceUrl: "https://www.akafoe.de/essen/mensen-und-cafeterien/speiseplan/Rote%20Bete",
    },
];

const LEGEND: Legend = {
    info: {
        A: "mit Alkohol",
        F: "mit Fisch",
        G: "mit Geflügel",
        H: "Halal",
        L: "mit Lamm",
        R: "mit Rind",
        S: "mit Schwein",
        V: "vegetarisch",
        VG: "vegan",
        W: "mit Wild",
    },
    allergens: {
        a: "Gluten",
        a1: "Weizen",
        a2: "Roggen",
        a3: "Gerste",
        a4: "Hafer",
        a5: "Dinkel",
        a6: "Kamut",
        b: "Krebstiere",
        c: "Eier",
        d: "Fisch",
        e: "Erdnüsse",
        f: "Sojabohnen",
        g: "Milch",
        h: "Schalenfrüchte",
        h1: "Mandel",
        h2: "Haselnuss",
        h3: "Walnuss",
        h4: "Cashewnuss",
        h5: "Pekannuss",
        h6: "Paranuss",
        h7: "Pistazie",
        h8: "Macadamia/Queenslandnuss",
        i: "Sellerie",
        j: "Senf",
        k: "Sesamsamen",
        l: "Schwefeldioxid",
        m: "Lupinen",
        n: "Weichtiere",
    },
    additives: {
        "1": "mit Farbstoff",
        "2": "mit Konservierungsstoff",
        "3": "mit Antioxidationsmittel",
        "4": "mit Geschmacksverstärker",
        "5": "geschwefelt",
        "6": "geschwärzt",
        "7": "gewachst",
        "8": "mit Phosphat",
        "9": "mit Süßungsmittel(n)",
        "10": "enthält eine Phenylalaninquelle",
        "11": "kann bei übermäßigem Verzehr abführend wirken",
        "12": "koffeinhaltig",
        "13": "chininhaltig",
    },
};

const WEEKDAY_ABBREVS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

async function fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "application/json",
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function formatDayLabel(dateStr: string): string {
    const date = new Date(`${dateStr}T00:00:00Z`);
    const weekday = WEEKDAY_ABBREVS[date.getUTCDay()];
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${weekday}, ${day}.${month}.`;
}

function formatPrice(value: number): string {
    return value.toFixed(2).replace(".", ",") + " €";
}

function convertApiMeal(meal: ApiMeal): MealEntry {
    const allCodes = [...meal.icons, ...meal.allergens, ...meal.additives];
    const allergensRaw = allCodes.length > 0 ? allCodes.join(",") : null;

    const priceValues: number[] = [];
    const priceLabels: string[] = [];
    if (meal.price_student != null) {
        priceValues.push(meal.price_student);
        priceLabels.push("students");
    }
    if (meal.price_employee != null) {
        priceValues.push(meal.price_employee);
        priceLabels.push("staff");
    }
    if (meal.price_guest != null) {
        priceValues.push(meal.price_guest);
        priceLabels.push("guests");
    }

    // Deduplicate if staff === guests (old format used 2 values in that case)
    if (
        priceValues.length === 3 &&
        priceValues[1] === priceValues[2]
    ) {
        priceValues.splice(1, 1);
        priceLabels.splice(1, 1);
        priceLabels[0] = "students";
        priceLabels[1] = "guests";
    }

    const price: MealPrice | null =
        priceValues.length > 0
            ? {
                raw: priceValues.map(formatPrice).join(" / "),
                currency: "EUR",
                values: priceValues,
                labels: priceLabels,
            }
            : null;

    return {
        title: meal.title,
        allergens: allCodes,
        allergensRaw,
        price,
        highlight: meal.is_featured,
    };
}

function convertApiDay(apiDay: ApiDay): DayMenu {
    const dateStr = apiDay.date.slice(0, 10);

    const categoryMap = new Map<string, MealEntry[]>();
    for (const meal of apiDay.meals) {
        const catName = meal.category.name;
        if (!categoryMap.has(catName)) {
            categoryMap.set(catName, []);
        }
        categoryMap.get(catName)!.push(convertApiMeal(meal));
    }

    const categories: MealCategory[] = [];
    for (const [title, meals] of categoryMap) {
        categories.push({title, meals});
    }

    return {
        date: dateStr,
        label: formatDayLabel(dateStr),
        categories,
    };
}

async function fetchCanteenMenus(canteen: CanteenConfig): Promise<DayMenu[]> {
    const dayMenus: DayMenu[] = [];
    const seenDates = new Set<string>();

    for (const period of ["current", "next"] as const) {
        const url = `${API_BASE}/meal-plans/week/${period}?canteen_id=${canteen.apiId}`;
        try {
            const weekData = await fetchJson<ApiWeekResponse>(url);
            for (const apiDay of weekData.days) {
                if (apiDay.meals.length === 0) continue;
                const dayMenu = convertApiDay(apiDay);
                if (!seenDates.has(dayMenu.date)) {
                    seenDates.add(dayMenu.date);
                    dayMenus.push(dayMenu);
                }
            }
        } catch (error) {
            console.warn(`Warning: failed to fetch ${period} week for ${canteen.name}: ${error}`);
        }
    }

    return dayMenus;
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
        const dayMenus = await fetchCanteenMenus(canteen);
        const partitions = groupByWeek(dayMenus);

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
                sourceUrl: canteen.sourceUrl,
                legend: LEGEND,
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

// Reward rates and credit limits for the owner's cards, as a quick reference only.
// Credit limits and autopay days are the owner's own numbers; the monthly rate check never changes them.
// Autopay days are kept here, not in Notion Bills, because that list is for hand-paid bills only.
// Rates come from each card's public terms and reviews; card companies change
// them, so the page links to each official page to check before relying on it.

export interface CardRate { cat: string; rate: number; note?: string }
export interface Card { id: string; name: string; short: string; limit: number; autopayDay: number | null; color: string; link: string; base: number; rates: CardRate[]; notes: string[] }

export const CATEGORIES = [
  "Dining",
  "Grocery stores",
  "Entertainment",
  "Streaming",
  "Drugstores",
  "Gas",
  "Travel via card's site",
  "Everything else",
];

export const CARDS: Card[] = [
  {
    id: "savor",
    name: "Capital One Savor",
    short: "Savor",
    limit: 2300,
    autopayDay: 27,
    color: "peach",
    link: "https://www.capitalone.com/credit-cards/savor/",
    base: 1,
    rates: [
      { cat: "Dining", rate: 3 },
      { cat: "Grocery stores", rate: 3, note: "not superstores like Walmart or Target" },
      { cat: "Entertainment", rate: 3 },
      { cat: "Streaming", rate: 3, note: "popular services" },
      { cat: "Travel via card's site", rate: 5, note: "hotels and rental cars through Capital One Travel" },
      { cat: "Capital One Entertainment", rate: 8, note: "tickets bought through Capital One Entertainment" },
    ],
    notes: ["Everything else earns 1%."],
  },
  {
    id: "cfu",
    name: "Chase Freedom Unlimited",
    short: "Freedom",
    limit: 3000,
    autopayDay: 2,
    color: "sky",
    link: "https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited",
    base: 1.5,
    rates: [
      { cat: "Dining", rate: 3, note: "includes takeout and eligible delivery" },
      { cat: "Drugstores", rate: 3 },
      { cat: "Travel via card's site", rate: 5, note: "booked through Chase Travel" },
    ],
    notes: ["Everything else earns 1.5%."],
  },
  {
    id: "fidelity",
    name: "Fidelity Rewards Visa",
    short: "Fidelity",
    limit: 12000,
    autopayDay: null,
    color: "mint",
    link: "https://www.fidelity.com/go/rewards-visa-signature",
    base: 2,
    rates: [],
    notes: ["The 2% needs rewards deposited into an eligible Fidelity account."],
  },
];

/** The rate a card earns in a category (its base rate when there is no bonus). */
export function rateFor(card: Card, cat: string): number {
  return card.rates.find((r) => r.cat === cat)?.rate ?? card.base;
}

/** For each category, the card or cards that earn the most. */
export function bestByCategory(): Array<{ cat: string; rate: number; cards: Card[] }> {
  return CATEGORIES.map((cat) => {
    const top = Math.max(...CARDS.map((c) => rateFor(c, cat)));
    return { cat, rate: top, cards: CARDS.filter((c) => rateFor(c, cat) === top) };
  });
}

/** The next date (YYYY-MM-DD) an autopay day falls on, today included. Short months use their last day. */
export function nextAutopay(day: number, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const pick = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // mm is 1-based here
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };
  const thisMonth = pick(y, m);
  if (thisMonth.slice(8) >= String(d).padStart(2, "0")) return thisMonth;
  return m === 12 ? pick(y + 1, 1) : pick(y, m + 1);
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return n + s;
}

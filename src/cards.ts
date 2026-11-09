// Reward rates for the owner's cards, as a quick reference only.
// Rates come from each card's public terms and reviews; card companies change
// them, so the page links to each official page to check before relying on it.

export interface CardRate { cat: string; rate: number; note?: string }
export interface Card { id: string; name: string; short: string; color: string; link: string; base: number; rates: CardRate[]; notes: string[] }

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

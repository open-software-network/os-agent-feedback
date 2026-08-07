import { createExperienceGraph } from "@epode/node/experience-graph";

/**
 * PetSmart automatic-feeder catalog expressed as a merchant-authored
 * experience graph. One catalog is the single source of truth for the human
 * storefront and the agent negotiation surface.
 *
 * The demo journey: a household with two adult cats and a dog, where one pet
 * is strongly food-motivated and steals from the others. Only the RFID
 * multi-pet feeder matches that need exactly; everything else surfaces as a
 * near miss with evidence.
 */

export const BRAND = "PetSmart";
export const TAGLINE = "Anything for Pets";

export const feederCatalog = {
  protocol: "epode-agent-experience/1.0",
  category: "feeder",
  priorityWeights: {
    functional_fit: 4,
    price: 0,
    connectivity: 2,
  },
  dimensions: [
    {
      key: "pets",
      kind: "enum",
      question: "Which pets will share this feeder?",
      whyItMatters:
        "Multi-pet homes need per-pet access control; single-pet homes only need portioning.",
      anchorMeaning: "The household's pet mix is known",
      allowUnknown: true,
      choices: [
        {
          token: "pets-one-cat",
          value: "one_cat",
          meaning: "One cat",
          strength: "hard",
        },
        {
          token: "pets-multiple-cats",
          value: "multiple_cats",
          meaning: "Two or more cats",
          strength: "hard",
        },
        {
          token: "pets-one-dog",
          value: "one_dog",
          meaning: "One dog",
          strength: "hard",
        },
        {
          token: "pets-multiple-dogs",
          value: "multiple_dogs",
          meaning: "Two or more dogs",
          strength: "hard",
        },
        {
          token: "pets-cats-and-dog",
          value: "cats_and_dog",
          meaning: "Multiple cats plus a dog share the home",
          strength: "hard",
        },
      ],
    },
    {
      key: "motivation",
      kind: "enum",
      question: "How food-motivated are the pets?",
      whyItMatters:
        "A strongly food-motivated pet will finish its bowl and raid the others'; that requires physical access control, not just scheduling.",
      anchorMeaning: "The pets' food motivation is known",
      allowUnknown: true,
      choices: [
        {
          token: "motivation-one-food-motivated",
          value: "one_food_motivated",
          meaning: "One pet is highly food-motivated and steals from the others",
          strength: "hard",
        },
        {
          token: "motivation-all-balanced",
          value: "all_balanced",
          meaning: "Every pet eats its own portion at mealtime",
          strength: "hard",
        },
        {
          token: "motivation-grazers",
          value: "grazers",
          meaning: "Pets graze slowly through the day",
          strength: "hard",
        },
      ],
    },
    {
      key: "budget",
      kind: "budget",
      question: "What budget value and strength are known for this purchase?",
      whyItMatters: "A hard ceiling excludes feeders; a target permits an explicit tradeoff.",
      anchorMeaning: "A budget ceiling or target is known",
      choices: [50, 90, 100, 150, 175, 200, 250].flatMap((amount) => [
        {
          token: `budget-hard-${amount}`,
          value: String(amount),
          meaning: `$${amount} absolute maximum`,
          strength: "hard",
        },
        {
          token: `budget-target-${amount}`,
          value: String(amount),
          meaning: `$${amount} preferred target`,
          strength: "target",
        },
      ]),
    },
    {
      key: "priority",
      kind: "priority",
      question: "Which criterion should dominate ranking?",
      whyItMatters: "Priority resolves tradeoffs between otherwise similar feeders.",
      anchorMeaning: "The dominant ranking criterion is known",
      optional: true,
      choices: [
        { token: "priority-functional-fit", value: "functional_fit", meaning: "Functional fit" },
        { token: "priority-price", value: "price", meaning: "Lowest total price" },
        { token: "priority-connectivity", value: "connectivity", meaning: "App and Wi-Fi control" },
      ],
    },
  ],
  items: [
    {
      id: "smarttag-rfid-multi-pet-feeder",
      title: "SmartTag RFID Multi-Pet Feeder",
      brand: "PetSafe",
      category: "feeder",
      price: { amount: 189.99, currency: "USD" },
      attributes: {
        features: [
          "RFID collar-tag access control",
          "per-pet portion schedules",
          "locking lid blocks food stealing",
          "two-station feeding",
          "cats and dogs",
        ],
      },
      matches: {
        pets: ["cats_and_dog", "multiple_cats", "multiple_dogs"],
        motivation: ["one_food_motivated"],
        brand: ["petsafe"],
      },
    },
    {
      id: "surefeed-microchip-cat-feeder",
      title: "SureFeed Microchip Cat Feeder",
      brand: "Sure Petcare",
      category: "feeder",
      price: { amount: 169.99, currency: "USD" },
      attributes: {
        features: [
          "microchip access control",
          "sealed bowl keeps food fresh",
          "cat-sized feeding arch",
        ],
      },
      matches: {
        pets: ["one_cat", "multiple_cats"],
        motivation: ["one_food_motivated"],
        brand: ["sure petcare"],
      },
    },
    {
      id: "whisker-city-programmable-feeder",
      title: "Whisker City Programmable Feeder",
      brand: "Whisker City",
      category: "feeder",
      price: { amount: 79.99, currency: "USD" },
      attributes: {
        features: ["five scheduled meals", "portion control", "voice recording"],
      },
      matches: {
        pets: ["one_cat"],
        motivation: ["all_balanced"],
        brand: ["whisker city"],
      },
    },
    {
      id: "petlibro-wifi-camera-feeder",
      title: "Petlibro Granary Wi-Fi Camera Feeder",
      brand: "Petlibro",
      category: "feeder",
      price: { amount: 139.99, currency: "USD" },
      attributes: {
        features: ["1080p meal camera", "app scheduling", "portion control", "Wi-Fi"],
      },
      matches: {
        pets: ["one_cat", "one_dog"],
        motivation: ["all_balanced"],
        connectivity: ["wifi", "app"],
        brand: ["petlibro"],
      },
    },
    {
      id: "top-paw-slow-feeder-bowl",
      title: "Top Paw Slow Feeder Bowl",
      brand: "Top Paw",
      category: "feeder",
      price: { amount: 12.99, currency: "USD" },
      attributes: {
        features: ["maze ridges slow fast eaters", "non-slip base", "dishwasher safe"],
      },
      matches: {
        pets: ["one_dog"],
        motivation: ["one_food_motivated"],
        brand: ["top paw"],
      },
    },
    {
      id: "top-paw-gravity-feeder",
      title: "Top Paw Gravity Feeder Duo",
      brand: "Top Paw",
      category: "feeder",
      price: { amount: 24.99, currency: "USD" },
      attributes: {
        features: ["six-pound hopper", "always-full bowl", "no power needed"],
      },
      matches: {
        pets: ["one_dog", "one_cat"],
        motivation: ["grazers"],
        brand: ["top paw"],
      },
    },
  ],
};

export const graph = createExperienceGraph(feederCatalog);

export function humanCatalogSummary() {
  return feederCatalog.items.map((item) => ({
    id: item.id,
    title: item.title,
    brand: item.brand,
    price: item.price,
    features: item.attributes?.features ?? [],
  }));
}

export function catalogItem(itemId) {
  return feederCatalog.items.find((item) => item.id === itemId);
}

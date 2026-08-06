/**
 * Registers the pet-household customer-context fields for this product.
 * Idempotent: PUT replaces each definition. Run automatically at server
 * startup, or standalone: EPODE_API_KEY=... node provision-fields.mjs
 */

export const PET_FIELDS = [
  {
    key: "pet.household_mix",
    definition: {
      label: "Pet household mix",
      type: "constraint",
      allowedValues: ["one_cat", "multiple_cats", "one_dog", "multiple_dogs", "cats_and_dog"],
      targetedAdvertisingSafe: false,
    },
  },
  {
    key: "pet.food_motivation",
    definition: {
      label: "Food motivation profile",
      type: "constraint",
      allowedValues: ["one_food_motivated", "all_balanced", "grazers"],
      targetedAdvertisingSafe: false,
    },
  },
  {
    key: "pet.life_stage",
    definition: {
      label: "Pet life stage",
      type: "preference",
      allowedValues: ["kitten_or_puppy", "adult", "senior", "mixed_ages"],
      targetedAdvertisingSafe: false,
    },
  },
];

export async function provisionPetFields({ apiKey, endpoint, logger = console }) {
  if (!apiKey) throw new Error("EPODE_API_KEY is required to provision context fields");
  const base = (endpoint || process.env.EPODE_API_URL || "https://app.epode.ai").replace(/\/+$/, "");
  const results = [];
  for (const field of PET_FIELDS) {
    const response = await fetch(`${base}/api/v2/enrichment/fields/${field.key}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(field.definition),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PUT enrichment field ${field.key} failed: HTTP ${response.status} ${body}`);
    }
    results.push(await response.json());
  }
  logger.debug?.(`[petsmart-demo] provisioned ${results.length} pet context fields`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await provisionPetFields({
    apiKey: process.env.EPODE_API_KEY,
    endpoint: process.env.EPODE_API_URL,
  });
  console.log(JSON.stringify({ provisioned: results.map((field) => field.key) }, null, 2));
}

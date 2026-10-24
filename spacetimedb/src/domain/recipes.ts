/**
 * Coffee-shop adapter for SYNC's generic task scheduler.
 *
 * Durations and costs below are illustrative simulator configuration, not
 * measurements of café operations or Anthropic API prices. Costs are modeled
 * micro-USD units (one millionth of a US dollar).
 *
 * Customer release is an environment event, not a worker task. The engine must
 * set the corresponding order condition before admitting collect_tray.
 */
export const ROLE_CAPACITIES = {
  cashier: 1,
  barista: 1,
  server: 1,
  cleaner: 1,
} as const;
export type Role = keyof typeof ROLE_CAPACITIES;
export type RecipeId = 'black_coffee' | 'latte';
// Display metadata copied into each order's recipe row.
export const RECIPE_INFO: Record<
  RecipeId,
  { name: string; description: string }
> = {
  black_coffee: {
    name: 'Black coffee',
    description: 'Brewed coffee, no milk.',
  },
  latte: { name: 'Latte', description: 'Brewed coffee with steamed milk.' },
};
export const TASK_KINDS = [
  'capture_order',
  'take_payment',
  'prepare_coffee',
  'prepare_milk',
  'assemble_drink',
  'pick_up_drink',
  'deliver_order',
  'collect_tray',
  'clean_tray',
  'return_tray',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export interface TaskDefinition {
  kind: TaskKind;
  role: Role;
  capabilities: string[];
  durationTicks: number;
  estimatedCostMicrousd: bigint;
  dependencies: TaskKind[];
  customerReleaseGuard: boolean;
  trayMode: 'none' | 'acquire' | 'release';
  rewardDelivery: boolean;
}
export const TASK_STEPS: Record<TaskKind, string[]> = {
  capture_order: [
    'Read the customer request.',
    'Validate the recipe and supported options.',
    'Calculate the illustrative order price.',
    'Record the validated order specification.',
  ],
  take_payment: [
    'Request simulated payment.',
    'Confirm simulated payment.',
    'Mark the order paid.',
  ],
  prepare_coffee: [
    'Read the validated recipe.',
    'Measure the required coffee ingredients.',
    'Brew the coffee base.',
    'Mark the coffee base ready.',
  ],
  prepare_milk: [
    'Read the validated milk option.',
    'Measure the required milk.',
    'Heat and froth the milk.',
    'Mark the prepared milk ready.',
  ],
  assemble_drink: [
    'Obtain all prepared components required by the recipe.',
    'Combine the components according to the recipe.',
    'Check the completed drink.',
    'Mark the drink ready for pickup.',
  ],
  pick_up_drink: [
    'Atomically acquire one clean serving tray for this order.',
    'Place the completed drink on the assigned tray.',
    'Verify the drink and order identities.',
  ],
  deliver_order: [
    'Move the assigned tray and drink to the customer.',
    'Hand over the drink.',
    'Confirm delivery once for this order.',
  ],
  collect_tray: [
    'Verify that the customer-release environment condition is satisfied.',
    'Collect the order-owned tray.',
    'Move the tray to the cleaning area.',
  ],
  clean_tray: [
    'Remove waste from the tray.',
    'Wash and sanitize the tray.',
    'Dry the tray.',
  ],
  return_tray: [
    'Return the tray to clean inventory.',
    'Clear the tray association with this order.',
    'Release reusable capacity exactly once.',
  ],
};
function definition(
  kind: TaskKind,
  role: Role,
  durationTicks: number,
  dependencies: TaskKind[],
  options: Partial<
    Pick<TaskDefinition, 'customerReleaseGuard' | 'trayMode' | 'rewardDelivery'>
  > = {},
): TaskDefinition {
  return {
    kind,
    role,
    capabilities: [role],
    durationTicks,
    estimatedCostMicrousd: BigInt(durationTicks) * 1000n,
    dependencies,
    customerReleaseGuard: false,
    trayMode: 'none',
    rewardDelivery: false,
    ...options,
  };
}
/**
 * Returns fresh task definitions in stable topological order.
 *
 * The latte fork permits coffee and milk preparation to run concurrently. A
 * black-coffee order contains no milk task and assembly waits only for coffee.
 * Serving-tray ownership extends across tasks until return_tray succeeds; a
 * normal task-attempt reservation expiry must not release that order-owned tray.
 */
export function materializeRecipe(recipe: RecipeId): TaskDefinition[] {
  if (!isRecipeId(recipe)) {
    throw new Error(`Unsupported recipe: ${String(recipe)}`);
  }
  const tasks: TaskDefinition[] = [
    definition('capture_order', 'cashier', 2, []),
    definition('take_payment', 'cashier', 2, ['capture_order']),
    definition('prepare_coffee', 'barista', 5, ['take_payment']),
  ];
  if (recipe === 'latte') {
    tasks.push(definition('prepare_milk', 'barista', 4, ['take_payment']));
  }
  tasks.push(
    definition(
      'assemble_drink',
      'barista',
      2,
      recipe === 'latte'
        ? ['prepare_coffee', 'prepare_milk']
        : ['prepare_coffee'],
    ),
    definition('pick_up_drink', 'server', 1, ['assemble_drink'], {
      trayMode: 'acquire',
    }),
    definition('deliver_order', 'server', 2, ['pick_up_drink'], {
      rewardDelivery: true,
    }),
    definition('collect_tray', 'cleaner', 1, ['deliver_order'], {
      customerReleaseGuard: true,
    }),
    definition('clean_tray', 'cleaner', 4, ['collect_tray']),
    definition('return_tray', 'cleaner', 1, ['clean_tray'], {
      trayMode: 'release',
    }),
  );
  return tasks;
}
export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && TASK_KINDS.some((kind) => kind === value);
}
export function isRecipeId(value: unknown): value is RecipeId {
  return value === 'black_coffee' || value === 'latte';
}
export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ROLE_CAPACITIES, value)
  );
}

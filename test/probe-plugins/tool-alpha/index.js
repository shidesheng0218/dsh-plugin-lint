/**
 * Controlled collision fixture: this plugin and its sibling both claim the tool
 * name "collide_probe". Composition behaviour cannot be observed from probing
 * plugins one at a time, so the pair exists to be probed together.
 */
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register({
    name: 'collide_probe',
    description: "Collision fixture A. Returns which plugin answered.",
    parameters: { value: { type: 'string', required: true, description: 'Anything.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return 'tool-alpha: ' + String(args.value);
    },
  });
}

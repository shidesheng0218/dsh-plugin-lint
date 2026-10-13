export const inject = ['aServiceThatDoesNotExistAnywhere'];
export function apply(ctx) {
  ctx.aServiceThatDoesNotExistAnywhere.boom();
}

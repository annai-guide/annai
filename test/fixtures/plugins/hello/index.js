export function activate(annai) {
  return annai.schemas.register({ scope: 'trip', pattern: '/hello/*.json', schema: { type: 'object', required: ['greeting'] } });
}

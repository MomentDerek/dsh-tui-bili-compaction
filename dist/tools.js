import { ACP_STATUS_TOOL, COMPRESS_TOOL, DECOMPRESS_TOOL } from './kernel.js';
const OUTPUT_SCHEMA = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
};
const ACP_HINT = 'Call acp_status first: it lists the compressible ranges (mNNNNN–mNNNNN) the kernel advertises for this conversation, the active blocks, and the current context usage.';
const ACP_STATUS_PARAMETERS = {
    type: 'object',
    properties: {
        scope: {
            type: 'string',
            enum: ['compressed', 'uncompressed'],
            description: 'Drill into one side of the ledger instead of the overview.',
        },
        view: {
            type: 'string',
            enum: ['ranges', 'messages'],
            description: 'With scope=uncompressed: group messages into ranges (default) or list them one by one.',
        },
        tool: { type: 'string', description: 'With scope=uncompressed view=messages: only messages from this tool.' },
        sort: { type: 'string', enum: ['size', 'time'], description: 'Order of the drill-down list.' },
        limit: { type: 'number', description: 'Maximum number of rows to print (default 10 for ranges).' },
    },
    additionalProperties: false,
};
function statusQuery(args) {
    if (typeof args !== 'object' || args === null)
        return {};
    const record = args;
    const query = {};
    const scope = record['scope'];
    if (scope === 'compressed' || scope === 'uncompressed')
        query.scope = scope;
    const view = record['view'];
    if (view === 'ranges' || view === 'messages')
        query.view = view;
    const tool = record['tool'];
    if (typeof tool === 'string' && tool.length > 0)
        query.tool = tool;
    const sort = record['sort'];
    if (sort === 'size' || sort === 'time')
        query.sort = sort;
    const limit = record['limit'];
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0)
        query.limit = Math.floor(limit);
    return query;
}
function textTool(name, description, parameters, run) {
    return {
        name,
        description,
        parameters,
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const text = typeof value === 'object' && value !== null && typeof value.text === 'string'
                    ? value.text
                    : String(value);
                return [{ type: 'text', text }];
            },
        },
        execute: async (args, exec) => ({ text: run(args, exec) }),
    };
}
function blockIdArg(args) {
    if (typeof args === 'string')
        return args;
    if (typeof args !== 'object' || args === null)
        return '';
    const record = args;
    for (const key of ['blockId', 'block_id', 'block', 'id']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return '';
}
function fullArg(args) {
    if (typeof args !== 'object' || args === null)
        return false;
    const value = args['full'];
    return value === true;
}
/**
 * Register the kernel's compress/decompress/acp_status surface as dsh tools.
 *
 * The schemas are the kernel's own (`COMPRESS_TOOL` and friends), so the model
 * sees exactly the argument shapes billon-context's proxy advertises; only the
 * transport changes (an in-process tool instead of an HTTP manifest).
 */
export function registerTools(host, engine, options = {}) {
    const disposers = [];
    const withSession = (exec, run) => {
        const session = exec.agent?.session ?? options.currentSession?.();
        if (session === undefined)
            return 'No active dsh session for this call.';
        return run(session);
    };
    const compress = textTool(COMPRESS_TOOL.name, `${COMPRESS_TOOL.description}\n\n${ACP_HINT}`, COMPRESS_TOOL.input_schema, ((args, exec) => withSession(exec, (session) => {
        const measurement = options.measure?.(session);
        return engine.compress(session, args, measurement).text;
    })));
    disposers.push(host.register(compress));
    const decompress = textTool(DECOMPRESS_TOOL.name, `${DECOMPRESS_TOOL.description}\n\nThe original content is returned as this tool's output; the compressed summary stays in the conversation, so the prompt cache is untouched.`, DECOMPRESS_TOOL.input_schema, ((args, exec) => withSession(exec, (session) => engine.decompress(session, blockIdArg(args), fullArg(args)))));
    disposers.push(host.register(decompress));
    const status = textTool(ACP_STATUS_TOOL.name, `${ACP_STATUS_TOOL.description}\n\nThis is the dsh-native status of the in-process kernel: refs are stable for the life of the log. The default output ends with the compressible ranges and their mNNNNN refs; pass scope/view to drill in.`, ACP_STATUS_PARAMETERS, ((args, exec) => withSession(exec, (session) => engine.status(session, options.measure?.(session), statusQuery(args)))));
    disposers.push(host.register(status));
    return disposers;
}
//# sourceMappingURL=tools.js.map
import Anthropic from '@anthropic-ai/sdk';
import {
  actionSchema,
  type AgentObservation,
  type JobResult,
} from '@sync/contracts';
import type { WorkerProvider } from './deterministic-worker';
export class ClaudeWorker implements WorkerProvider {
  private client: Anthropic;
  constructor(
    private model: string,
    apiKey: string,
    timeout: number,
  ) {
    this.client = new Anthropic({ apiKey, timeout, maxRetries: 0 });
  }
  async propose(o: AgentObservation): Promise<JobResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system:
        'Propose the admitted operation. Never claim completion. Use exactly the task ID and attempt provided.',
      messages: [{ role: 'user', content: JSON.stringify(o) }],
      tools: [
        {
          name: 'start_operation',
          description:
            'Request authoritative simulated execution of this admitted task.',
          input_schema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['start_operation'] },
              taskId: { type: 'string' },
              attempt: { type: 'integer', minimum: 1 },
            },
            required: ['type', 'taskId', 'attempt'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'start_operation',
        disable_parallel_tool_use: true,
      },
    });
    const tool = response.content.find((c) => c.type === 'tool_use');
    if (!tool || tool.type !== 'tool_use')
      throw new Error('Missing action proposal');
    const action = actionSchema.parse(tool.input);
    if (action.taskId !== o.taskId || action.attempt !== o.attempt)
      throw new Error('Model proposed a different task attempt');
    return {
      action,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import {
  type ChatMessage,
  type EditorDefinition,
  type Inputs,
  type InternalProcessContext,
  type NodeBodySpec,
  type Outputs,
} from '../../index.js';
import { mapValues } from 'lodash-es';
import { dedent } from 'ts-dedent';
import { coerceType, coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/index.js';

export type PromptNode = ChartNode<'prompt', PromptNodeData>;

export type PromptNodeData = {
  type: 'system' | 'user' | 'assistant' | 'function';
  useTypeInput: boolean;

  promptText: string;

  name?: string;
  useNameInput?: boolean;
  enableFunctionCall?: boolean;
  computeTokenCount?: boolean;
};

export class PromptNodeImpl extends NodeImpl<PromptNode> {
  static create(): PromptNode {
    const chartNode: PromptNode = {
      type: 'prompt',
      title: 'Prompt',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        type: 'user',
        useTypeInput: false,
        promptText: '{{input}}',
        enableFunctionCall: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    let inputs: NodeInputDefinition[] = [];

    if (this.data.enableFunctionCall) {
      inputs.push({
        id: 'function-call' as PortId,
        title: 'Function Call',
        dataType: 'object',
      });
    }

    if (this.data.useTypeInput) {
      inputs.push({
        id: 'type' as PortId,
        title: 'Type',
        dataType: 'string',
      });
    }

    if (this.data.useNameInput) {
      inputs.push({
        id: 'name' as PortId,
        title: 'Name',
        dataType: 'string',
      });
    }

    // Extract inputs from promptText, everything like {{input}}
    const inputNames = [...new Set(this.chartNode.data.promptText.match(/\{\{([^}]+)\}\}/g))];
    inputs = [
      ...inputs,
      ...(inputNames?.map((inputName): NodeInputDefinition => {
        return {
          // id and title should not have the {{ and }}
          id: inputName.slice(2, -2) as PortId,
          title: inputName.slice(2, -2),
          dataType: 'string',
          required: false,
        };
      }) ?? []),
    ];

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [
      {
        id: 'output' as PortId,
        title: 'Output',
        dataType: 'chat-message',
      },
    ];

    if (this.chartNode.data.computeTokenCount) {
      outputs.push({
        id: 'tokenCount' as PortId,
        title: 'Token Count',
        dataType: 'number',
      });
    }

    return outputs;
  }

  getEditors(): EditorDefinition<PromptNode>[] {
    return [
      {
        type: 'dropdown',
        label: 'Type',
        options: [
          { value: 'system', label: 'System' },
          { value: 'user', label: 'User' },
          { value: 'assistant', label: 'Assistant' },
          { value: 'function', label: 'Function' },
        ],
        dataKey: 'type',
        useInputToggleDataKey: 'useTypeInput',
      },
      {
        type: 'string',
        label: 'Name',
        dataKey: 'name',
        useInputToggleDataKey: 'useNameInput',
      },
      {
        type: 'toggle',
        label: 'Enable Function Call',
        dataKey: 'enableFunctionCall',
      },
      {
        type: 'toggle',
        label: 'Compute Token Count',
        dataKey: 'computeTokenCount',
      },
      {
        type: 'code',
        label: 'Prompt Text',
        dataKey: 'promptText',
        language: 'prompt-interpolation-markdown',
        theme: 'prompt-interpolation',
      },
    ];
  }

  getBody(): string | NodeBodySpec | NodeBodySpec[] | undefined {
    return [
      {
        type: 'markdown',
        text: dedent`
          _${typeDisplay[this.data.type]}${this.data.name ? ` (${this.data.name})` : ''}_
      `,
      },
      {
        type: 'colorized',
        text: this.data.promptText.split('\n').slice(0, 15).join('\n').trim(),
        language: 'prompt-interpolation-markdown',
        theme: 'prompt-interpolation',
      },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Outputs a chat message, which is a string of text with an attached "type" saying who sent the message (User, Assistant, System) and optionally an attached "name".

        Also provides the same <span style="color: var(--primary)">{{interpolation}}</span> capabilities as a Text node.

        Can change one chat message type into another chat message type. For example, changing a User message into a System message.
      `,
      infoBoxTitle: 'Prompt Node',
      contextMenuTitle: 'Prompt',
      group: ['Text'],
    };
  }

  interpolate(baseString: string, values: Record<string, string>): string {
    return baseString.replace(/\{\{([^}]+)\}\}/g, (_m, p1) => {
      const value = values[p1];
      return value !== undefined ? value : '';
    });
  }

  async process(inputs: Inputs, context: InternalProcessContext<PromptNode>): Promise<Outputs> {
    const inputMap = mapValues(inputs, (input) => coerceType(input, 'string')) as Record<PortId, string>;

    const outputValue = this.interpolate(this.chartNode.data.promptText, inputMap);

    const type = getInputOrData(this.data, inputs, 'type', 'string');

    if (['assistant', 'system', 'user', 'function'].includes(type) === false) {
      throw new Error(`Invalid type: ${type}`);
    }

    const name = getInputOrData(this.data, inputs, 'name', 'string');

    let functionCall = this.data.enableFunctionCall
      ? coerceTypeOptional(inputs['function-call' as PortId], 'object')
      : undefined;

    // If no name is specified, ignore the function call
    if (!functionCall?.name || !functionCall?.arguments) {
      functionCall = undefined;
    }

    // GPT is weird - the arguments should be a stringified JSON object https://platform.openai.com/docs/api-reference/chat/create
    if (functionCall?.arguments && typeof functionCall.arguments !== 'string') {
      functionCall.arguments = JSON.stringify(functionCall.arguments);
    }

    const message: ChatMessage = {
      type: type as 'assistant' | 'system' | 'user' | 'function',
      message: outputValue,
      name,

      // Standardize to only have name and arguments (discard other props)
      function_call: functionCall
        ? {
            name: functionCall.name,
            arguments: functionCall.arguments,
          }
        : undefined,
    };

    const outputs: Outputs = {
      ['output' as PortId]: {
        type: 'chat-message',
        value: message,
      },
    };

    if (this.chartNode.data.computeTokenCount) {
      const tokenCount = context.tokenizer.getTokenCountForMessages([message], {
        node: this.chartNode,
      });
      outputs['tokenCount' as PortId] = {
        type: 'number',
        value: tokenCount,
      };
    }

    return outputs;
  }
}

export const promptNode = nodeDefinition(PromptNodeImpl, 'Prompt');

const typeDisplay: Record<PromptNodeData['type'], string> = {
  assistant: 'Assistant',
  system: 'System',
  user: 'User',
  function: 'Function',
};

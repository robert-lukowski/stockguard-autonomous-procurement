import {
  DynamoConditionalCheckFailed,
  type DynamoCommand,
  type DynamoCommandResult,
  type DynamoDocumentPort,
} from "./dynamoDocument";

/**
 * An in-memory DynamoDB test double.
 *
 * Exists so the durable adapters can be tested against the SAME contract test
 * as their in-memory counterparts. A queue of canned responses (the pattern the
 * judge store's own tests use) proves which commands were sent; it cannot prove
 * that a conditional write actually excludes a concurrent writer. This does,
 * because it really evaluates the condition against real stored state.
 *
 * It supports exactly the expression forms this repository uses, and throws on
 * anything else rather than silently returning a pass. A new expression form
 * must therefore be added here deliberately, which is the point: an unsupported
 * condition must never evaluate to "allowed".
 */
export class InMemoryDynamoDocument implements DynamoDocumentPort {
  private readonly items = new Map<string, Record<string, unknown>>();
  readonly commands: DynamoCommand[] = [];

  private static id(key: Record<string, unknown>): string {
    return `${String(key.PK)} ${String(key.SK)}`;
  }

  /** Only the forms below are recognised; everything else throws. */
  private evaluate(
    expression: string | undefined,
    existing: Record<string, unknown> | undefined,
    names: Record<string, string> = {},
    values: Record<string, unknown> = {},
  ): boolean {
    if (!expression) return true;

    return expression.split(" AND ").every((rawClause) => {
      const clause = rawClause.trim();

      if (/^attribute_not_exists\(([^)]+)\)$/.test(clause)) {
        return existing === undefined;
      }

      const exists = /^attribute_exists\(([^)]+)\)$/.exec(clause);
      if (exists) {
        const attribute = names[exists[1].trim()] ?? exists[1].trim();
        return existing !== undefined && existing[attribute] !== undefined;
      }

      const equality = /^(\S+)\s*=\s*(:\S+)$/.exec(clause);
      if (equality) {
        if (existing === undefined) return false;
        const attribute = names[equality[1]] ?? equality[1];
        const expected = values[equality[2]];
        const actual = existing[attribute] ?? null;
        return actual === expected;
      }

      throw new Error(`InMemoryDynamoDocument cannot evaluate condition: ${clause}`);
    });
  }

  private applyUpdate(
    item: Record<string, unknown>,
    updateExpression: string,
    names: Record<string, string>,
    values: Record<string, unknown>,
  ): void {
    const set = /^SET\s+(.*)$/i.exec(updateExpression.trim());
    if (!set) {
      throw new Error(`InMemoryDynamoDocument cannot apply update: ${updateExpression}`);
    }
    for (const assignment of set[1].split(",")) {
      const parsed = /^(\S+)\s*=\s*(:\S+)$/.exec(assignment.trim());
      if (!parsed) {
        throw new Error(
          `InMemoryDynamoDocument cannot apply assignment: ${assignment.trim()}`,
        );
      }
      item[names[parsed[1]] ?? parsed[1]] = structuredClone(values[parsed[2]]);
    }
  }

  async execute(command: DynamoCommand): Promise<DynamoCommandResult> {
    this.commands.push(structuredClone(command));

    if (command.operation === "Get") {
      const item = this.items.get(InMemoryDynamoDocument.id(command.key));
      return item ? { item: structuredClone(item) } : {};
    }

    if (command.operation === "Put") {
      const id = InMemoryDynamoDocument.id(command.item);
      const existing = this.items.get(id);
      if (
        !this.evaluate(
          command.conditionExpression,
          existing,
          command.expressionAttributeNames,
          command.expressionAttributeValues,
        )
      ) {
        throw new DynamoConditionalCheckFailed("The conditional request failed");
      }
      this.items.set(id, structuredClone(command.item));
      return {};
    }

    if (command.operation === "Update") {
      const id = InMemoryDynamoDocument.id(command.key);
      const existing = this.items.get(id);
      if (
        !this.evaluate(
          command.conditionExpression,
          existing,
          command.expressionAttributeNames,
          command.expressionAttributeValues,
        )
      ) {
        throw new DynamoConditionalCheckFailed("The conditional request failed");
      }
      const item = existing ?? structuredClone(command.key);
      this.applyUpdate(
        item,
        command.updateExpression,
        command.expressionAttributeNames,
        command.expressionAttributeValues,
      );
      this.items.set(id, item);
      return {};
    }

    if (command.operation === "Query") {
      const parsed = /^(\S+)\s*=\s*(:\S+)$/.exec(command.keyConditionExpression.trim());
      if (!parsed) {
        throw new Error(
          `InMemoryDynamoDocument cannot evaluate key condition: ${command.keyConditionExpression}`,
        );
      }
      const attribute = command.expressionAttributeNames[parsed[1]] ?? parsed[1];
      const wanted = command.expressionAttributeValues[parsed[2]];
      const items = [...this.items.values()]
        .filter((item) => item[attribute] === wanted)
        .sort((left, right) => String(left.SK).localeCompare(String(right.SK)))
        .map((item) => structuredClone(item));
      return { items };
    }

    for (const write of command.items) {
      const id = InMemoryDynamoDocument.id(write.item);
      if (
        !this.evaluate(
          write.conditionExpression,
          this.items.get(id),
          write.expressionAttributeNames,
          write.expressionAttributeValues,
        )
      ) {
        throw new DynamoConditionalCheckFailed("The conditional request failed");
      }
    }
    for (const write of command.items) {
      this.items.set(InMemoryDynamoDocument.id(write.item), structuredClone(write.item));
    }
    return {};
  }

  get size(): number {
    return this.items.size;
  }
}

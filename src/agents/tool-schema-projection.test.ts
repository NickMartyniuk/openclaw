import { describe, expect, it } from "vitest";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  inspectRuntimeToolInputSchemas,
  projectRuntimeToolInputSchema,
} from "./tool-schema-projection.js";

describe("runtime tool input schema projection", () => {
  it("accepts JSON object input schemas", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        properties: {
          angle: { type: "number" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        properties: {
          angle: { type: "number" },
        },
      },
      violations: [],
    });
  });

  it("reports non-object dynamic tool input schemas", () => {
    expect(
      inspectRuntimeToolInputSchemas([
        {
          name: "fuzzplugin_move_angles",
          parameters: { type: "array", items: { type: "number" } },
        },
      ] as never),
    ).toEqual([
      {
        toolName: "fuzzplugin_move_angles",
        toolIndex: 0,
        violations: ['fuzzplugin_move_angles.parameters.type must be "object"'],
      },
    ]);
  });

  it("reports dynamic JSON Schema keywords", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        anyOf: [{ $dynamicAnchor: "root" }],
        properties: {
          target: { $dynamicRef: "#target" },
        },
      }),
    ).toEqual({
      schema: {
        type: "object",
        anyOf: [{ $dynamicAnchor: "root" }],
        properties: {
          target: { $dynamicRef: "#target" },
        },
      },
      violations: [
        "parameters.anyOf[0].$dynamicAnchor",
        "parameters.properties.target.$dynamicRef",
      ],
    });
  });

  it("does not report schema map field names as dynamic JSON Schema keywords", () => {
    expect(
      projectRuntimeToolInputSchema({
        type: "object",
        $defs: {
          $dynamicAnchor: { type: "string" },
        },
        properties: {
          $dynamicRef: { type: "string" },
        },
      }).violations,
    ).toEqual([]);
  });

  it("filters unsupported schemas without dropping healthy tools", () => {
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };
    const broken = {
      name: "fuzzplugin_move_angles",
      parameters: { type: "array", items: { type: "number" } },
    };

    expect(filterRuntimeCompatibleTools([healthy, broken])).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "fuzzplugin_move_angles",
          toolIndex: 1,
          violations: ['fuzzplugin_move_angles.parameters.type must be "object"'],
        },
      ],
    });
  });

  it("keeps provider-repairable schemas before provider normalization", () => {
    const missingParameters = {
      name: "missing_parameters",
      parameters: undefined,
    };
    const nonObjectSchema = {
      name: "fuzzplugin_move_angles",
      parameters: { type: "array", items: { type: "number" } },
    };
    const circularSchema = {
      name: "circular_schema",
      parameters: {} as { self?: unknown },
    };
    circularSchema.parameters.self = circularSchema.parameters;

    expect(
      filterProviderNormalizableTools([
        missingParameters,
        nonObjectSchema,
        circularSchema,
      ] as never),
    ).toEqual({
      tools: [missingParameters, nonObjectSchema],
      diagnostics: [
        {
          toolName: "circular_schema",
          toolIndex: 2,
          violations: ["circular_schema.parameters is not JSON-serializable"],
        },
      ],
    });
  });

  it("filters tools with unreadable descriptors without dropping healthy tools", () => {
    const unreadableName: Record<string, unknown> = {
      parameters: { type: "object", properties: {} },
    };
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin name is unreadable");
      },
    });
    const unreadableParameters: Record<string, unknown> = {
      name: "fuzzplugin_move_angles",
    };
    Object.defineProperty(unreadableParameters, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters are unreadable");
      },
    });
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };

    expect(
      filterRuntimeCompatibleTools([unreadableName, unreadableParameters, healthy] as never),
    ).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "tool[0]",
          toolIndex: 0,
          violations: ["tool[0].name is unreadable"],
        },
        {
          toolName: "fuzzplugin_move_angles",
          toolIndex: 1,
          violations: ["fuzzplugin_move_angles.parameters is unreadable"],
        },
      ],
    });
  });

  it("filters unreadable tool rows without dropping healthy tools", () => {
    const healthy = {
      name: "healthy",
      parameters: { type: "object", properties: {} },
    };
    const tools = [undefined, healthy] as unknown[];
    Object.defineProperty(tools, "0", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin tool row is unreadable");
      },
    });

    expect(filterRuntimeCompatibleTools(tools as never)).toEqual({
      tools: [healthy],
      diagnostics: [
        {
          toolName: "tool[0]",
          toolIndex: 0,
          violations: ["tool[0] is unreadable"],
        },
      ],
    });
  });
});

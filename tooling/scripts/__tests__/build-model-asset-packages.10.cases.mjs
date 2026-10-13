import { assert, fs, path, makeTempDir, runBuildScript, serialTest, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

const constrainedImageSizeField = (overrides = {}) => ({
  field_key: 'size',
  component: 'imageSize',
  label: 'fields.size.label',
  required: false,
  default_value: 'auto',
  component_props: {
    mode: 'constrainedResolution',
    allowAuto: true,
    sizeLevels: [
      { id: '2k', label: 'fields.size.sizeLevels.2k.label', pixelBudget: 4194304 },
      { id: '4k', label: 'fields.size.sizeLevels.4k.label', pixelBudget: 8294400 },
    ],
    aspectPresets: [
      { id: '16:9', label: 'fields.size.aspectPresets.16_9.label', ratio: 16 / 9 },
      { id: '9:16', label: 'fields.size.aspectPresets.9_16.label', ratio: 9 / 16 },
    ],
    presetOptions: [
      { value: 'auto', label: 'fields.size.presetOptions.auto.label' },
    ],
    constraints: {
      dimensionMultiple: 16,
      maxLongEdge: 3840,
      minPixels: 655360,
      maxPixels: 8294400,
      maxAspectRatio: 3,
    },
    ...overrides,
  },
});

const writeImageSizePackage = (tempDir, field) => writeSourcePackage(tempDir, {
  packageId: 'constrained-image-size',
  modelId: 'constrained-image-size',
  runtimeModel: {
    capability: {
      input_modalities: ['text'],
      output_modalities: ['image'],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        field,
      ],
    },
    prompt_field: {
      field_key: '__prompt',
      required: true,
      validation_rules: [],
    },
    runtime: {
      payload_rules: {
        'body.prompt': {
          kind: 'field',
          field_key: '__prompt',
        },
        'body.size': {
          kind: 'field',
          field_key: 'size',
        },
      },
    },
  },
  nodeDefinition: {
    input_ports: [],
    output_ports: [
      {
        id: 'image',
        name: 'ports.outputs.image.name',
        data_type: 'image',
        field_key: 'output_image',
      },
    ],
  },
});

serialTest('build-model-asset-packages: constrained imageSize 像素预算配置可通过并写入安装包', () => {
  const tempDir = makeTempDir();

  try {
    writeImageSizePackage(tempDir, constrainedImageSizeField());

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `脚本执行失败: ${result.stderr || result.stdout}`);

    const runtimeModel = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.model-assets', 'packages', 'constrained-image-size', 'runtime_model.json'), 'utf8'),
    );
    const sizeField = runtimeModel.parameter_schema.fields.find((field) => field.field_key === 'size');
    assert.deepEqual(sizeField.component_props.sizeLevels[1], {
      id: '4k',
      label: 'fields.size.sizeLevels.4k.label',
      pixelBudget: 8294400,
    });
    assert.deepEqual(sizeField.component_props.aspectPresets[0], {
      id: '16:9',
      label: 'fields.size.aspectPresets.16_9.label',
      ratio: 16 / 9,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: constrained imageSize customPresets 常见宽高可通过并写入安装包', () => {
  const tempDir = makeTempDir();

  try {
    writeImageSizePackage(tempDir, constrainedImageSizeField({
      customPresets: [
        { value: '1024x1024' },
        { value: '1536x1024', label: 'fields.size.customPresets.1536x1024.label' },
      ],
    }));

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `脚本执行失败: ${result.stderr || result.stdout}`);

    const runtimeModel = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.model-assets', 'packages', 'constrained-image-size', 'runtime_model.json'), 'utf8'),
    );
    const sizeField = runtimeModel.parameter_schema.fields.find((field) => field.field_key === 'size');
    assert.deepEqual(sizeField.component_props.customPresets, [
      { value: '1024x1024' },
      { value: '1536x1024', label: 'fields.size.customPresets.1536x1024.label' },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: constrained imageSize 非法 level 和 aspect 应阻断', () => {
  const cases = [
    {
      name: 'bad-level-over-max-pixels',
      overrides: { sizeLevels: [{ id: '5k', label: 'fields.size.sizeLevels.5k.label', pixelBudget: 16777216 }] },
      error: 'runtime_model.parameter_schema_image_size_level_pixel_budget_exceeded',
    },
    {
      name: 'bad-level-below-min-pixels',
      overrides: { sizeLevels: [{ id: 'xs', label: 'fields.size.sizeLevels.xs.label', pixelBudget: 1024 }] },
      error: 'runtime_model.parameter_schema_image_size_level_pixel_budget_below_min',
    },
    {
      name: 'bad-aspect',
      overrides: { aspectPresets: [{ id: '4:1', label: 'fields.size.aspectPresets.4_1.label', ratio: 4 }] },
      error: 'runtime_model.parameter_schema_image_size_aspect_preset_ratio_exceeded',
    },
    {
      name: 'bad-custom-preset-auto',
      overrides: { customPresets: [{ value: 'auto' }] },
      error: 'runtime_model.parameter_schema_image_size_custom_preset_invalid',
    },
    {
      name: 'bad-custom-preset-not-wxh',
      overrides: { customPresets: [{ value: '1024×1024' }] },
      error: 'runtime_model.parameter_schema_image_size_custom_preset_invalid',
    },
    {
      name: 'bad-custom-preset-dimension-multiple',
      overrides: { customPresets: [{ value: '1000x1000' }] },
      error: 'runtime_model.parameter_schema_image_size_custom_preset_dimension_multiple_invalid',
    },
    {
      name: 'bad-custom-preset-pixels-out-of-range',
      overrides: { customPresets: [{ value: '3840x2176' }] },
      error: 'runtime_model.parameter_schema_image_size_custom_preset_pixels_out_of_range',
    },
  ];

  for (const item of cases) {
    const tempDir = makeTempDir();
    try {
      writeImageSizePackage(tempDir, constrainedImageSizeField(item.overrides));
      const result = runBuildScript(tempDir);
      assert.notEqual(result.status, 0, `${item.name} 应阻断打包`);
      assert.match(result.stderr || result.stdout, new RegExp(item.error));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

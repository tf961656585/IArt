import { assert, fs, path, makeTempDir, runBuildScript, serialTest, withRequiredRuntime, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: 合法包源可成功打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'zimage');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'zimage',
      entry_model: {
        model_id: 'z-image-turbo',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [
        {
          resource_id: 'provider-alibaba-icon',
          media_type: 'image/svg+xml',
          relative_path: 'resources/alibaba.svg',
        },
      ],
      locales: [
        {
          locale: 'zh-CN',
          relative_path: 'locales/zh-CN.json',
        },
        {
          locale: 'en',
          relative_path: 'locales/en.json',
        },
      ],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('z-image-turbo', {
      capability: {
        input_modalities: ['text'],
        output_modalities: ['image'],
        supports_async_task: false,
      },
      parameter_schema: {
        fields: [
          {
            field_key: 'size',
            component: 'text',
            required: false,
          },
        ],
      },
      // prompt 从 parameter_schema 剥离（方案 B）：顶层 prompt_field 声明 + payload_rules 引用保留键
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
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });
    fs.mkdirSync(path.join(sourceDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'resources', 'alibaba.svg'), '<svg></svg>', 'utf8');
    writeJson(path.join(sourceDir, 'locales', 'zh-CN.json'), {});
    writeJson(path.join(sourceDir, 'locales', 'en.json'), {});

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `脚本执行失败: ${result.stderr || result.stdout}`);
    assert.match(
      result.stdout,
      /\[model-asset-projection-contract\].*"projectionCount":1/,
      '打包成功前必须验证 Backend 模型资产投响应共享契约',
    );

    const outputDir = path.join(tempDir, '.model-assets', 'packages', 'zimage');
    assert.equal(fs.existsSync(path.join(outputDir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'runtime_model.json')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'node_definition.json')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'resources', 'alibaba.svg')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'locales', 'zh-CN.json')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'locales', 'en.json')), true);
    const builtNodeDefinition = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'node_definition.json'), 'utf8'),
    );
    assert.equal('display_name' in builtNodeDefinition, false, '打包产物不应补回旧字段');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 模型资产包使用 pages 全局 key 时阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'broken-localization-model',
      modelId: 'broken-localization-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'mode',
              component: 'select',
              label: 'pages:modelWorkspace.tengxunKling.fields.imageMode.label',
              enum_options: [
                {
                  value: 'broken',
                  label: 'pages:modelWorkspace.tengxunKling.fields.imageMode.options.notExists',
                },
              ],
            },
          ],
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'mode',
            name: 'pages:modelWorkspace.tengxunKling.fields.imageMode.label',
            data_type: 'text',
            field_key: 'mode',
            required: true,
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '使用 pages 全局 key 时应阻断打包');
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /localization\.global_key_not_allowed:broken-localization-model:/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 模型资产包使用 models 全局 key 时阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'broken-models-localization',
      modelId: 'broken-models-localization',
      runtimeModel: {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              component: 'text',
              label: 'models.notExists.label',
              required: true,
            },
          ],
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'size',
            name: 'Size',
            data_type: 'text',
            field_key: 'size',
            required: true,
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '使用 models 全局 key 时应阻断打包');
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /localization\.global_key_not_allowed:broken-models-localization:parameter_schema\.fields\.size\.label:models\.notExists\.label/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 端口未解析 key 时阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'broken-port-localization',
      modelId: 'broken-port-localization',
      runtimeModel: {
        capability: {
          input_modalities: ['image'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'referenceImage',
              component: 'imageUpload',
              label: 'fields.referenceImage.label',
              description: 'fields.referenceImage.description',
            },
          ],
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'referenceImage',
            name: 'ports.inputs.referenceImage.name',
            description: 'ports.inputs.referenceImage.description',
            data_type: 'image',
            field_key: 'referenceImage',
          },
        ],
        output_ports: [
          {
            id: 'video',
            name: 'ports.outputs.video.name',
            data_type: 'video',
            field_key: 'output_video',
          },
        ],
      },
      locales: {
        'zh-CN': {
          fields: {
            referenceImage: {
              label: '参考图',
              description: '上传参考图以控制主体动作。',
            },
          },
          ports: {
            inputs: {
              referenceImage: {
                name: '参考图',
                description: '参考图输入',
              },
            },
          },
        },
        en: {
          fields: {
            referenceImage: {
              label: 'Reference image',
              description: 'Upload a reference image.',
            },
          },
          ports: {
            inputs: {
              referenceImage: {
                name: 'Reference image',
                description: 'Reference image input',
              },
            },
          },
        },
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '未解析端口名应阻断打包');
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /localization\.port_name_missing:broken-port-localization:(zh-CN|en):/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 完整双语文案 key 可通过打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'localized-kling-model',
      modelId: 'localized-kling-model',
      runtimeModel: {
        capability: {
          input_modalities: ['video'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'modelVersion',
              component: 'select',
              label: 'fields.modelVersion.label',
              enum_options: [
                {
                  value: '2.6',
                  label: 'fields.modelVersion.options.v26.label',
                },
              ],
            },
            {
              field_key: 'motionControlSourceVideo',
              component: 'file',
              label: 'fields.motionControlSourceVideo.label',
              description: 'fields.motionControlSourceVideo.description',
            },
          ],
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'motionControlSourceVideo',
            name: 'ports.inputs.motionControlSourceVideo.name',
            description: 'ports.inputs.motionControlSourceVideo.description',
            data_type: 'video',
            field_key: 'motionControlSourceVideo',
          },
        ],
        output_ports: [
          {
            id: 'video',
            name: 'ports.outputs.video.name',
            data_type: 'video',
            field_key: 'output_video',
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `完整双语 key 应可打包: ${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

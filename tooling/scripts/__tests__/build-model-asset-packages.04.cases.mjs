import { assert, fs, path, makeTempDir, runBuildScript, serialTest, withRequiredRuntime, withTestLocales, writeDefaultLocalizationFiles, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: runtime 顶层 camelCase 旧口径应在构建阶段被阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'camelcase-runtime-meta',
      modelId: 'camelcase-runtime-meta-model',
      rawRuntimeModel: {
        model_id: 'camelcase-runtime-meta-model',
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
        runtime: {
          providerId: 'google',
          modelId: 'camelcase-runtime-meta-model',
          adapterKey: 'gemini_text',
          payloadRules: {
            'body.prompt': {
              kind: 'field',
              field_key: 'size',
            },
          },
        },
      },
    });

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, 'camelCase runtime 顶层字段不应再被打包');
    assert.match(
      buildResult.stderr || buildResult.stdout,
      /runtime_model\.runtime\.provider_id_legacy_key_not_allowed:providerId/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: payload_rules 内的 fieldKey 旧口径应在构建阶段被阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'camelcase-field-rule',
      modelId: 'camelcase-field-rule-model',
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
              required: false,
            },
          ],
        },
        runtime: {
          payload_rules: {
            'body.prompt': {
              kind: 'field',
              fieldKey: 'size',
            },
          },
        },
      },
    });

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, 'payload_rules.fieldKey 不应再被打包');
    assert.match(
      buildResult.stderr || buildResult.stdout,
      /runtime_model\.runtime\.payload_rules_field_key_legacy_key_not_allowed:fieldKey/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: polling camelCase 旧口径应在构建阶段被阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'camelcase-polling',
      modelId: 'camelcase-polling-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: true,
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
        runtime: {
          execution_driver: 'http_formal_task',
          payload_rules: {
            'body.prompt': {
              kind: 'field',
              field_key: 'size',
            },
          },
          polling: {
            enabled: true,
            nonBlocking: true,
            statusEndpointTemplate: '/v1/tasks/{requestId}',
          },
        },
      },
    });

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, 'polling camelCase 字段不应再被打包');
    assert.match(buildResult.stderr || buildResult.stdout, /runtime_model\.runtime\.polling_not_supported/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 未知 transforms 应在构建阶段被阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'unknown-transform',
      modelId: 'unknown-transform-model',
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
              required: false,
            },
          ],
        },
        runtime: {
          payload_rules: {
            'body.prompt': {
              kind: 'field',
              field_key: 'size',
              transforms: ['trim_typo'],
            },
          },
        },
      },
    });

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, '未知 transforms 不应再被成功打包');
    assert.match(
      buildResult.stderr || buildResult.stdout,
      /runtime_model\.runtime\.payload_rules_transform_unknown:trim_typo/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 通用结构化 operator、map_array、断言/数值/解析 operator 与 Gemini 特殊 operator 可被构建器接受并回写到 package', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'structured-runtime');
    writeJson(path.join(sourceDir, 'manifest.json'), withTestLocales({
      package_id: 'structured-runtime',
      entry_model: {
        model_id: 'structured-runtime-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    }));
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('structured-runtime-model', {
      capability: {
        input_modalities: ['text'],
        output_modalities: ['image'],
        supports_async_task: false,
      },
        parameter_schema: {
          fields: [
            {
              field_key: 'userText',
              component: 'textarea',
              required: false,
            },
            {
              field_key: 'images',
              component: 'imageUpload',
              required: false,
            },
            {
              field_key: 'size',
              component: 'select',
              required: false,
            },
            {
              field_key: 'speakerVoiceLines',
              component: 'textarea',
              required: false,
            },
            {
              field_key: 'seconds',
              component: 'number',
              required: false,
            },
        ],
      },
      runtime: {
        default_task_type: 'image',
        mode: 'image',
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: 'self_hosted_image_public_url',
        payload_rules: {
          'body.contents': {
            kind: 'compute',
            operator: 'build_content_blocks',
            media_target: 'inline_data',
            options: {
              role: 'user',
              parts: [
                {
                  part_kind: 'text',
                  value: {
                    kind: 'field',
                    field_key: 'userText',
                    transforms: ['trim'],
                  },
                  skip_if_empty: true,
                },
                {
                  part_kind: 'inline_data',
                  value: {
                    kind: 'field',
                    field_key: 'images',
                  },
                  multiple: true,
                  max_items: 3,
                  skip_if_empty: true,
                },
              ],
            },
          },
          'body.request': {
            kind: 'compute',
            operator: 'compact_object',
            entries: {
              prompt: {
                kind: 'field',
                field_key: 'userText',
                transforms: ['trim'],
              },
              size: {
                kind: 'compute',
                operator: 'normalize_enum',
                args: [
                  {
                    kind: 'field',
                    field_key: 'size',
                  },
                ],
                options: {
                  allowed_values: ['1024', '2048'],
                  fallback: '1024',
                },
              },
            },
          },
          'body.image_list': {
            kind: 'compute',
            operator: 'map_array',
            options: {
              source: {
                kind: 'field',
                field_key: 'images',
                media_target: 'public_url',
                transforms: ['extractUrls'],
              },
              item: {
                kind: 'compute',
                operator: 'object',
                entries: {
                  image: {
                    kind: 'item',
                  },
                },
              },
              max_items: 2,
              skip_if_empty: true,
            },
          },
          'body.speakerVoiceConfigs': {
            kind: 'compute',
            operator: 'parse_line_pairs',
            args: [
              {
                kind: 'field',
                field_key: 'speakerVoiceLines',
              },
            ],
            options: {
              left_key: 'speaker',
              right_key: 'voiceName',
              pair_delimiter: '|',
            },
          },
          'meta.required_images': {
            kind: 'compute',
            operator: 'assert_array_length',
            args: [
              {
                kind: 'field',
                field_key: 'images',
                media_target: 'public_url',
                transforms: ['extractUrls'],
              },
            ],
            options: {
              min_items: 1,
              max_items: 2,
            },
          },
          'meta.last_image': {
            kind: 'field',
            field_key: 'images',
            media_target: 'public_url',
            transforms: ['extractUrls', 'last'],
          },
          'meta.sound_end_ms': {
            kind: 'compute',
            operator: 'scale_number',
            args: [
              {
                kind: 'field',
                field_key: 'seconds',
                transforms: ['toNumber'],
              },
            ],
            options: {
              factor: 1000,
              round: 'round',
            },
          },
          'meta.sound_volume': {
            kind: 'compute',
            operator: 'clamp_number',
            args: [
              {
                kind: 'field',
                field_key: 'seconds',
                transforms: ['toNumber'],
              },
            ],
            options: {
              min: 0,
              max: 2,
            },
          },
          'meta.sample_items': {
            kind: 'compute',
            operator: 'map_array',
            options: {
              source: {
                kind: 'literal',
                value: [
                  {
                    id: 'cover',
                    meta: {
                      slot: 'left',
                    },
                  },
                ],
              },
              item: {
                kind: 'compute',
                operator: 'object',
                entries: {
                  raw: {
                    kind: 'item',
                  },
                  id: {
                    kind: 'item',
                    path: 'id',
                  },
                  slot: {
                    kind: 'item',
                    path: 'meta.slot',
                  },
                },
              },
              prepend: [
                {
                  kind: 'literal',
                  value: [
                    {
                      id: 'intro',
                    },
                  ],
                },
              ],
              append: [
                {
                  kind: 'literal',
                  value: {
                    id: 'outro',
                  },
                },
              ],
              max_items: 1,
              skip_if_empty: true,
            },
          },
          'meta.tags': {
            kind: 'compute',
            operator: 'compact_array',
            args: [
              {
                kind: 'literal',
                value: 'image',
              },
              {
                kind: 'literal',
                value: '',
              },
            ],
          },
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
      input_ports: [
        {
          id: 'images',
          name: '图片',
          data_type: 'image',
          field_key: 'images',
          multiple: true,
        },
      ],
      output_ports: [
        {
          id: 'image',
          name: '图像',
          data_type: 'image',
          field_key: 'output_image',
        },
      ],
    });
    writeDefaultLocalizationFiles(
      sourceDir,
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'runtime_model.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'node_definition.json'), 'utf8')),
    );

    const buildResult = runBuildScript(tempDir);
    assert.equal(buildResult.status, 0, `脚本执行失败: ${buildResult.stderr || buildResult.stdout}`);

    const packageRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tempDir, '.model-assets', 'packages', 'structured-runtime', 'runtime_model.json'),
        'utf8',
      ),
    );
    assert.equal(packageRuntime.runtime?.payload_rules?.['body.contents']?.operator, 'build_content_blocks');
    assert.equal(packageRuntime.runtime?.payload_rules?.['body.request']?.operator, 'compact_object');
    assert.equal(packageRuntime.runtime?.payload_rules?.['body.image_list']?.operator, 'map_array');
    assert.equal(packageRuntime.runtime?.payload_rules?.['body.speakerVoiceConfigs']?.operator, 'parse_line_pairs');
    assert.equal(packageRuntime.runtime?.payload_rules?.['meta.required_images']?.operator, 'assert_array_length');
    assert.equal(packageRuntime.runtime?.payload_rules?.['meta.sound_end_ms']?.operator, 'scale_number');
    assert.equal(packageRuntime.runtime?.payload_rules?.['meta.sound_volume']?.operator, 'clamp_number');
    assert.equal(packageRuntime.runtime?.payload_rules?.['meta.sample_items']?.operator, 'map_array');
    assert.equal(packageRuntime.runtime?.payload_rules?.['meta.tags']?.operator, 'compact_array');
    assert.deepEqual(packageRuntime.runtime?.payload_rules?.['meta.last_image']?.transforms, ['extractUrls', 'last']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

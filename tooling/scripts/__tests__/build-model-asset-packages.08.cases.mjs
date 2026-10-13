import { assert, fs, path, escapeRegExp, makeTempDir, runBuildScript, serialTest, test, withRequiredRuntime, withTestLocales, writeDefaultLocalizationFiles, writeJson } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: runtime.url_input_upload_mode=public_relay 可通过并写入安装包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'url-upload-mode-ok');
    writeJson(path.join(sourceDir, 'manifest.json'), withTestLocales({
      package_id: 'url-upload-mode-ok',
      entry_model: {
        model_id: 'url-upload-mode-ok-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    }));
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('url-upload-mode-ok-model', {
      capability: {
        input_modalities: ['image'],
        output_modalities: ['image'],
        supports_async_task: false,
      },
      parameter_schema: {
        fields: [
          {
            field_key: 'images',
            component: 'imageUpload',
            required: false,
          },
        ],
      },
      runtime: {
        execution_driver: 'http_formal_task',
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: 'self_hosted_image_public_url',
        payload_rules: {
          'body.images': {
            kind: 'field',
            field_key: 'images',
            media_target: 'public_url',
            transforms: ['extractUrls'],
          },
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
      input_ports: [
        {
          id: 'images',
          name: 'Images',
          data_type: 'image',
          field_key: 'images',
        },
      ],
    });
    writeDefaultLocalizationFiles(
      sourceDir,
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'runtime_model.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'node_definition.json'), 'utf8')),
    );

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `url_input_upload_mode 合法场景不应阻断: ${result.stderr || result.stdout}`);

    const packageRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tempDir, '.model-assets', 'packages', 'url-upload-mode-ok', 'runtime_model.json'),
        'utf8',
      ),
    );
    assert.equal(packageRuntime.runtime?.url_input_upload_mode, 'public_relay');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: runtime.url_input_upload_mode 非法值或错误落位应阻断打包', () => {
  const cases = [
    {
      name: '非法值',
      runtime: {
        url_input_upload_mode: 'cloudflare',
      },
      expected: /runtime_model\.runtime\.url_input_upload_mode_invalid/,
    },
    {
      name: '错误落位',
      runtime: {
        capabilities: {
          url_input_upload_mode: 'public_relay',
        },
      },
      expected: /runtime_model\.runtime\.url_input_upload_mode_wrong_location/,
    },
  ];

  cases.forEach(({ name, runtime, expected }) => {
    const tempDir = makeTempDir();

    try {
      const sourceDir = path.join(tempDir, '.model-assets', 'sources', `url-upload-mode-${name}`);
      writeJson(path.join(sourceDir, 'manifest.json'), {
        package_id: `url-upload-mode-${name}`,
        entry_model: {
          model_id: `url-upload-mode-${name}-model`,
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      });
      writeJson(
        path.join(sourceDir, 'runtime_model.json'),
        withRequiredRuntime(`url-upload-mode-${name}-model`, {
          capability: {
            input_modalities: ['image'],
            output_modalities: ['image'],
            supports_async_task: false,
          },
          parameter_schema: {
            fields: [
              {
                field_key: 'images',
                component: 'textarea',
                required: false,
              },
            ],
          },
          runtime: {
            execution_driver: 'http_formal_task',
            ...runtime,
          },
        }),
      );
      writeJson(path.join(sourceDir, 'node_definition.json'), {
        node_type: 'model',
      });

      const result = runBuildScript(tempDir);
      assert.notEqual(result.status, 0, `${name} 应阻断打包`);
      assert.match(result.stderr, expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

serialTest('build-model-asset-packages: runtime.api_defaults 禁止远端请求超时和重试字段', () => {
  const cases = ['timeoutMs', 'retries', 'retryDelayMs'];

  cases.forEach((field) => {
    const tempDir = makeTempDir();

    try {
      const sourceDir = path.join(tempDir, '.model-assets', 'sources', `remote-governance-${field}`);
      writeJson(path.join(sourceDir, 'manifest.json'), {
        package_id: `remote-governance-${field}`,
        entry_model: {
          model_id: `remote-governance-${field}-model`,
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      });
      writeJson(
        path.join(sourceDir, 'runtime_model.json'),
        withRequiredRuntime(`remote-governance-${field}-model`, {
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
            execution_driver: 'http_formal_task',
            api_defaults: {
              endpoint: '/v1/test',
              method: 'POST',
              [field]: field === 'retryDelayMs' ? 1000 : 1,
            },
          },
        }),
      );
      writeJson(path.join(sourceDir, 'node_definition.json'), {
        node_type: 'model',
      });

      const result = runBuildScript(tempDir);
      assert.notEqual(result.status, 0, `runtime.api_defaults.${field} 应阻断打包`);
      assert.match(
        result.stderr || result.stdout,
        new RegExp(`runtime_model\\.runtime\\.api_defaults_remote_request_governance_forbidden:${field}`),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

serialTest('build-model-asset-packages: literal 缺失 value 时应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-literal');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-literal',
      entry_model: {
        model_id: 'bad-literal-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-literal-model', {
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
        execution_driver: 'http_formal_task',
        payload_rules: {
          'body.prompt': {
            kind: 'literal',
          },
        },
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'literal 缺失 value 应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime\.payload_rules_literal_value_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 非法 role 应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'bad-role');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'bad-role',
      entry_model: {
        model_id: 'bad-role-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('bad-role-model', {
      role: 'invalid-role',
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
        execution_driver: 'http_formal_task',
      },
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '非法 role 应阻断打包');
    assert.match(result.stderr, /runtime_model\.role_invalid:invalid-role/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: runtime 缺失时应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'missing-runtime');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'missing-runtime',
      entry_model: {
        model_id: 'missing-runtime-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), {
      model_id: 'missing-runtime-model',
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
    });
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'runtime 缺失应阻断打包');
    assert.match(result.stderr, /runtime_model\.runtime_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

[
  ['provider_id', 'runtime_model.runtime.provider_id_missing'],
  ['execution_driver', 'runtime_model.runtime.execution_driver_missing'],
].forEach(([fieldKey, expectedError]) => {
  test(`build-model-asset-packages: runtime.${fieldKey} 缺失时应阻断打包`, () => {
    const tempDir = makeTempDir();

    try {
      const sourceDir = path.join(tempDir, '.model-assets', 'sources', `missing-${fieldKey}`);
      writeJson(path.join(sourceDir, 'manifest.json'), {
        package_id: `missing-${fieldKey}`,
        entry_model: {
          model_id: `missing-${fieldKey}-model`,
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      });
      writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime(`missing-${fieldKey}-model`, {
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
          [fieldKey]: '   ',
        },
      }));
      writeJson(path.join(sourceDir, 'node_definition.json'), {
        node_type: 'model',
      });

      const result = runBuildScript(tempDir);
      assert.notEqual(result.status, 0, `runtime.${fieldKey} 缺失应阻断打包`);
      assert.match(result.stderr, new RegExp(escapeRegExp(expectedError)));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

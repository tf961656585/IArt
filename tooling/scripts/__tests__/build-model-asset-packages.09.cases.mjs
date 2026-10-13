import { assert, fs, path, escapeRegExp, makeTempDir, runBackendCatalog, runBuildScript, serialTest, withRequiredRuntime, withTestLocales, writeDefaultLocalizationFiles, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: model 节点若仍保留二次选模字段应阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'secondary-model-selector',
      modelId: 'secondary-model-selector',
      rawRuntimeModel: withRequiredRuntime('secondary-model-selector', {
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          schema_type: 'object',
          fields: [
            {
              field_key: 'model',
              component: 'select',
              required: false,
              enum_options: [{ value: 'variant-a' }, { value: 'variant-b' }],
            },
            {
              field_key: 'size',
              component: 'text',
              required: false,
            },
          ],
          required_fields: ['size'],
          default_values: { model: 'variant-a', size: '1024' },
        },
      }),
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secondary_model_selector_not_allowed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: resource 指向目录时应阻断打包且 Backend 判定坏包', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'resource-dir');
    writeJson(path.join(sourceDir, 'manifest.json'), withTestLocales({
      package_id: 'resource-dir',
      entry_model: {
        model_id: 'resource-dir-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [
        {
          resource_id: 'resource-dir',
          media_type: 'image/svg+xml',
          relative_path: 'resources',
        },
      ],
    }));
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('resource-dir-model', {
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
    }));
    writeJson(path.join(sourceDir, 'node_definition.json'), {
      node_type: 'model',
    });
    writeDefaultLocalizationFiles(
      sourceDir,
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'runtime_model.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'node_definition.json'), 'utf8')),
    );
    fs.mkdirSync(path.join(sourceDir, 'resources'), { recursive: true });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, 'resource 目录应阻断打包');
    assert.match(result.stderr, /manifest\.resource_missing/);

    const packageDir = path.join(tempDir, '.model-assets', 'packages', 'resource-dir');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.cpSync(sourceDir, packageDir, { recursive: true });

    const backendResult = runBackendCatalog(tempDir, {
      packageRoot: path.join(tempDir, '.model-assets', 'packages'),
    });
    assert.equal(backendResult.status, 0, backendResult.stderr || backendResult.stdout);
    const catalog = JSON.parse(backendResult.stdout || '{}');
    const diagnostic = Array.isArray(catalog.diagnostics)
      ? catalog.diagnostics.find((item) => item?.package_id === 'resource-dir' && item?.code === 'bad_package')
      : null;
    assert.ok(diagnostic, 'Backend 应将 resource 目录判定为坏包');
    assert.match(String(diagnostic.message ?? ''), /manifest\.resource_missing/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: duplicate model_id 冲突应阻断打包', () => {
  const tempDir = makeTempDir();

  try {
    const writePkg = (packageId, modelId) => {
      const sourceDir = path.join(tempDir, '.model-assets', 'sources', packageId);
      writeJson(path.join(sourceDir, 'manifest.json'), withTestLocales({
        package_id: packageId,
        entry_model: {
          model_id: modelId,
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      }));
      writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime(modelId, {
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
      }));
      writeJson(path.join(sourceDir, 'node_definition.json'), {
        node_type: 'model',
      });
      writeDefaultLocalizationFiles(
        sourceDir,
        JSON.parse(fs.readFileSync(path.join(sourceDir, 'runtime_model.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(sourceDir, 'node_definition.json'), 'utf8')),
      );
    };

    writePkg('dup-a', 'same-model-id');
    writePkg('dup-b', 'same-model-id');

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '重复 model_id 应阻断打包');
    assert.match(result.stderr, /duplicate_model_id: same-model-id/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 打包脚本与 Backend 读取器对坏包诊断码保持一致', () => {
  const cases = [
    {
      name: 'parameter_schema component 缺失',
      expectedCode: 'runtime_model.parameter_schema_component_missing:0',
      runtimeModel: {
        model_id: 'case-component-missing-model',
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'size',
              required: true,
            },
          ],
        },
      },
      manifest: {
        package_id: 'case-component-missing',
        entry_model: {
          model_id: 'case-component-missing-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'capability.constraints 非对象列表',
      expectedCode: 'runtime_model.capability_constraints_item_invalid:0',
      runtimeModel: {
        model_id: 'case-capability-constraints-model',
        capability: {
          input_modalities: ['text'],
          output_modalities: ['image'],
          supports_async_task: false,
          constraints: ['reference_images_max_7'],
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
      },
      manifest: {
        package_id: 'case-capability-constraints',
        entry_model: {
          model_id: 'case-capability-constraints-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'payload_rules literal 缺失 value',
      expectedCode: 'runtime_model.runtime.payload_rules_literal_value_missing',
      runtimeModel: {
        model_id: 'case-literal-missing-model',
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
      },
      manifest: {
        package_id: 'case-literal-missing',
        entry_model: {
          model_id: 'case-literal-missing-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'runtime capabilities 非法结构',
      expectedCode: 'runtime_model.runtime.capabilities_ui_guards_invalid',
      runtimeModel: {
        model_id: 'case-capabilities-invalid-model',
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
          capabilities: {
            ui_guards: 'invalid',
          },
        },
      },
      manifest: {
        package_id: 'case-capabilities-invalid',
        entry_model: {
          model_id: 'case-capabilities-invalid-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'manifest.resources 缺失',
      expectedCode: 'manifest.resources_missing',
      runtimeModel: {
        model_id: 'case-missing-resources-model',
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
      },
      manifest: {
        package_id: 'case-missing-resources',
        entry_model: {
          model_id: 'case-missing-resources-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
      },
    },
    {
      name: 'manifest 使用 camelCase 别名字段',
      expectedCode: 'manifest.entry_model_missing',
      runtimeModel: {
        model_id: 'case-camel-manifest-model',
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
      },
      manifest: {
        package_id: 'case-camel-manifest',
        entryModel: {
          modelId: 'case-camel-manifest-model',
          relativePath: 'runtime_model.json',
        },
        nodeDefinition: {
          relativePath: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'manifest.packageId 别名字段',
      expectedCode: 'manifest.package_id_missing',
      runtimeModel: {
        model_id: 'case-package-id-camel-model',
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
      },
      manifest: {
        packageId: 'case-package-id-camel',
        entry_model: {
          model_id: 'case-package-id-camel-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'manifest.entry_model.modelId 别名字段',
      expectedCode: 'manifest.entry_model_model_id_missing',
      runtimeModel: {
        model_id: 'case-entry-model-id-camel-model',
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
      },
      manifest: {
        package_id: 'case-entry-model-id-camel',
        entry_model: {
          modelId: 'case-entry-model-id-camel-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'runtime_model.model_id 缺失',
      expectedCode: 'runtime_model.model_id_missing',
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
      },
      manifest: {
        package_id: 'case-runtime-model-id-missing',
        entry_model: {
          model_id: 'case-runtime-model-id-missing-model',
          relative_path: 'runtime_model.json',
        },
        node_definition: {
          relative_path: 'node_definition.json',
        },
        resources: [],
      },
    },
    {
      name: 'manifest 非对象',
      expectedCode: 'manifest_invalid',
      packageDirName: 'case-manifest-invalid',
      runtimeModel: {
        model_id: 'case-manifest-invalid-model',
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
      },
      manifest: [],
    },
  ];

  cases.forEach(({ name, expectedCode, runtimeModel, manifest, packageDirName: overridePackageDirName }) => {
    const tempDir = makeTempDir();
    try {
      const manifestRecord =
        manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? manifest
          : {};
      const packageDirName =
        (typeof overridePackageDirName === 'string' && overridePackageDirName) ||
        (typeof manifestRecord.package_id === 'string' && manifestRecord.package_id) ||
        (typeof manifestRecord.packageId === 'string' && manifestRecord.packageId) ||
        'case-unknown';
      const sourceRoot = path.join(tempDir, '.model-assets', 'sources', packageDirName);
      const packageRoot = path.join(tempDir, '.model-assets', 'packages', packageDirName);
      const manifestWithLocales =
        manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? withTestLocales(manifest)
          : manifest;
      writeJson(path.join(sourceRoot, 'manifest.json'), manifestWithLocales);
      const runtimePayload =
        runtimeModel &&
        typeof runtimeModel === 'object' &&
        !Array.isArray(runtimeModel) &&
        typeof runtimeModel.model_id === 'string'
          ? withRequiredRuntime(runtimeModel.model_id, runtimeModel)
          : runtimeModel;
      writeJson(path.join(sourceRoot, 'runtime_model.json'), runtimePayload);
      writeJson(path.join(sourceRoot, 'node_definition.json'), {
        node_type: 'model',
      });
      writeDefaultLocalizationFiles(
        sourceRoot,
        JSON.parse(fs.readFileSync(path.join(sourceRoot, 'runtime_model.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(sourceRoot, 'node_definition.json'), 'utf8')),
      );

      fs.cpSync(sourceRoot, packageRoot, { recursive: true });

      const buildResult = runBuildScript(tempDir);
      assert.notEqual(buildResult.status, 0, `${name}: 打包脚本应失败`);
      assert.match(
        buildResult.stderr,
        new RegExp(escapeRegExp(expectedCode)),
        `${name}: 打包脚本应输出诊断码`,
      );

      const backendResult = runBackendCatalog(tempDir, {
        packageRoot: path.join(tempDir, '.model-assets', 'packages'),
      });
      assert.equal(
        backendResult.status,
        0,
        `${name}: Backend 读取器执行失败: ${backendResult.stderr || backendResult.stdout}`,
      );
      const catalog = JSON.parse(backendResult.stdout || '{}');
      const badDiagnostic = Array.isArray(catalog.diagnostics)
        ? catalog.diagnostics.find(
            (item) => item?.package_id === packageDirName && item?.code === 'bad_package',
          )
        : null;
      assert.ok(badDiagnostic, `${name}: Backend 应输出 bad_package 诊断`);
      assert.match(
        String(badDiagnostic.message ?? ''),
        new RegExp(escapeRegExp(expectedCode)),
        `${name}: Backend bad_package 应包含与打包脚本一致的诊断码`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

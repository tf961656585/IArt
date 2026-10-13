import { assert, fs, path, makeTempDir, runBackendCatalog, runBuildScript, serialTest, withRequiredRuntime, writeJson, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: --package 可在存在其他 legacy source 时只重建选中包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'zimage',
      modelId: 'z-image-turbo',
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
      resources: [
        {
          resourceId: 'provider-alibaba-icon',
          mediaType: 'image/svg+xml',
          relativePath: 'resources/alibaba.svg',
          content: '<svg></svg>',
        },
      ],
    });
    writeSourcePackage(tempDir, {
      packageId: 'legacy-compute',
      modelId: 'legacy-compute-model',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
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
          default_task_type: 'image',
          mode: 'image',
          payload_rules: {
            'body.prompt': {
              kind: 'compute',
              operator: 'legacy_schema_compute',
              cache_key: 'trim.prompt',
              options: {
                model_id: 'legacy-compute-model',
                target_path: 'body.prompt',
              },
            },
          },
        },
      },
    });

    const result = runBuildScript(tempDir, ['--package', 'zimage']);
    assert.equal(result.status, 0, `局部重建不应被其他 legacy source 阻断: ${result.stderr || result.stdout}`);

    const outputRoot = path.join(tempDir, '.model-assets', 'packages');
    assert.equal(fs.existsSync(path.join(outputRoot, 'zimage', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'zimage', 'runtime_model.json')), true);
    assert.equal(fs.existsSync(path.join(outputRoot, 'legacy-compute')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: --package 只回写被点名 package，不清空未点名 package', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'zimage',
      modelId: 'z-image-turbo',
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
    });

    const staleTargetDir = path.join(tempDir, '.model-assets', 'packages', 'zimage');
    fs.mkdirSync(staleTargetDir, { recursive: true });
    fs.writeFileSync(path.join(staleTargetDir, 'stale.txt'), 'stale', 'utf8');

    const untouchedDir = path.join(tempDir, '.model-assets', 'packages', 'keep-existing');
    fs.mkdirSync(untouchedDir, { recursive: true });
    fs.writeFileSync(path.join(untouchedDir, 'sentinel.txt'), 'keep', 'utf8');

    const result = runBuildScript(tempDir, ['--package', 'zimage']);
    assert.equal(result.status, 0, `局部重建应成功: ${result.stderr || result.stdout}`);

    assert.equal(fs.existsSync(path.join(staleTargetDir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(staleTargetDir, 'runtime_model.json')), true);
    assert.equal(fs.existsSync(path.join(staleTargetDir, 'stale.txt')), false, '被点名 package 应先删除旧目录再重建');
    assert.equal(fs.existsSync(path.join(untouchedDir, 'sentinel.txt')), true, '未点名 package 不应被清空');
    assert.equal(fs.readFileSync(path.join(untouchedDir, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: backend 打包态可从 resources/model-assets 读取模型包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'zimage',
      modelId: 'z-image-turbo',
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
    });

    const buildResult = runBuildScript(tempDir);
    assert.equal(buildResult.status, 0, `脚本执行失败: ${buildResult.stderr || buildResult.stdout}`);

    const packagedRoot = path.join(tempDir, 'packaged-app', 'resources', 'model-assets');
    fs.mkdirSync(path.dirname(packagedRoot), { recursive: true });
    fs.cpSync(path.join(tempDir, '.model-assets', 'packages'), packagedRoot, { recursive: true });

    const catalogResult = runBackendCatalog(path.join(tempDir, 'packaged-app'), {
      resourcesPath: path.join(tempDir, 'packaged-app', 'resources'),
    });
    assert.equal(catalogResult.status, 0, `目录探测失败: ${catalogResult.stderr || catalogResult.stdout}`);

    const catalog = JSON.parse(catalogResult.stdout);
    assert.equal(catalog.package_root, packagedRoot);
    assert.equal(catalog.projections.some((item) => item.model_id === 'z-image-turbo'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: --package 仍会阻断与未点名 source 的 model_id 冲突', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'zimage',
      modelId: 'same-model-id',
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
    });
    writeSourcePackage(tempDir, {
      packageId: 'legacy-conflict',
      modelId: 'same-model-id',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
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
              kind: 'compute',
              operator: 'legacy_schema_compute',
              options: {
                model_id: 'same-model-id',
              },
            },
          },
        },
      },
    });

    const result = runBuildScript(tempDir, ['--package', 'zimage']);
    assert.notEqual(result.status, 0, '与未点名 source 的 model_id 冲突应阻断局部重建');
    assert.match(result.stderr, /duplicate_model_id: same-model-id/);
    assert.doesNotMatch(
      result.stderr,
      /legacy_schema_compute/,
      '未点名 source 不应被完整校验到 legacy runtime 错误',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: legacy_schema_compute 包应在构建阶段被阻断', () => {
  const tempDir = makeTempDir();

  try {
    const sourceDir = path.join(tempDir, '.model-assets', 'sources', 'legacy-compute');
    writeJson(path.join(sourceDir, 'manifest.json'), {
      package_id: 'legacy-compute',
      entry_model: {
        model_id: 'legacy-compute-model',
        relative_path: 'runtime_model.json',
      },
      node_definition: {
        relative_path: 'node_definition.json',
      },
      resources: [],
    });
    writeJson(path.join(sourceDir, 'runtime_model.json'), withRequiredRuntime('legacy-compute-model', {
      capability: {
        input_modalities: ['text', 'image'],
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
        default_task_type: 'image',
        mode: 'image',
        payload_rules: {
          'body.prompt': {
            kind: 'compute',
            operator: 'legacy_schema_compute',
            cache_key: 'trim.prompt',
            options: {
              model_id: 'legacy-compute-model',
              target_path: 'body.prompt',
            },
          },
          'body.images': {
            kind: 'field',
            field_key: 'images',
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

    const buildResult = runBuildScript(tempDir);
    assert.notEqual(buildResult.status, 0, 'legacy_schema_compute 不应再被成功打包');
    assert.match(
      buildResult.stderr || buildResult.stdout,
      /runtime_model\.runtime\.payload_rules_compute_operator_unknown:legacy_schema_compute/,
      '应明确指出 legacy_schema_compute 已不再受支持',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

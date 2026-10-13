import { assert, fs, path, makeTempDir, runBuildScript, serialTest, writeSourcePackage } from './build-model-asset-packages.test-helpers.mjs';

serialTest('build-model-asset-packages: public_relay 双 target_type 都可打包进安装包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'cloudflare-relay',
      modelId: 'cloudflare-relay',
      runtimeModel: {
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
          url_input_upload_mode: 'public_relay',
          url_input_upload_target_type: 'cloudflare_image_public_url',
          payload_rules: {
            'body.images': {
              kind: 'field',
              field_key: 'images',
              media_target: 'public_url',
              transforms: ['extractUrls'],
            },
          },
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'images',
            name: 'Images',
            data_type: 'image',
            field_key: 'images',
          },
        ],
      },
    });
    writeSourcePackage(tempDir, {
      packageId: 'self-hosted-relay',
      modelId: 'self-hosted-relay',
      runtimeModel: {
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
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'images',
            name: 'Images',
            data_type: 'image',
            field_key: 'images',
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `脚本执行失败: ${result.stderr || result.stdout}`);

    const cloudflarePackage = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.model-assets', 'packages', 'cloudflare-relay', 'runtime_model.json'), 'utf8'),
    );
    const selfHostedPackage = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.model-assets', 'packages', 'self-hosted-relay', 'runtime_model.json'), 'utf8'),
    );
    assert.equal(
      cloudflarePackage.runtime?.url_input_upload_target_type,
      'cloudflare_image_public_url',
    );
    assert.equal(
      selfHostedPackage.runtime?.url_input_upload_target_type,
      'self_hosted_image_public_url',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: self_hosted_image_public_url 不能声明非图像 public_url 输入', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'self-hosted-video-input',
      modelId: 'self-hosted-video-input',
      runtimeModel: {
        capability: {
          input_modalities: ['video'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'referenceVideo',
              component: 'file',
              required: false,
              component_props: {
                accept: 'video/mp4,video/*',
              },
            },
          ],
        },
        runtime: {
          url_input_upload_mode: 'public_relay',
          url_input_upload_target_type: 'self_hosted_image_public_url',
          payload_rules: {
            'body.video_url': {
              kind: 'field',
              field_key: 'referenceVideo',
              media_target: 'public_url',
              transforms: ['extractFirstUrl'],
            },
          },
        },
      },
      nodeDefinition: {
        input_ports: [],
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '非图像 public_url 字段不应允许使用 self-hosted image relay');
    assert.match(
      result.stderr || result.stdout,
      /runtime_model\.runtime\.public_url_self_hosted_non_image_field:referenceVideo/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: public_relay 缺失、旧值或错误落位的 target_type 必须阻断', () => {
  const cases = [
    {
      name: 'missing-target-type',
      runtime: {
        url_input_upload_mode: 'public_relay',
      },
      expected: /url_input_upload_target_type_missing/,
    },
    {
      name: 'legacy-target-type',
      runtime: {
        url_input_upload_mode: 'public_relay',
        url_input_upload_target_type: 'image_public_url',
      },
      expected: /url_input_upload_target_type_invalid:image_public_url/,
    },
    {
      name: 'wrong-location-target-type',
      runtime: {
        capabilities: {
          url_input_upload_target_type: 'cloudflare_image_public_url',
        },
      },
      expected: /url_input_upload_target_type_wrong_location/,
    },
  ];

  for (const { name, runtime, expected } of cases) {
    const tempDir = makeTempDir();
    try {
      writeSourcePackage(tempDir, {
        packageId: name,
        modelId: name,
        runtimeModel: {
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
            payload_rules: {
              'body.images': {
                kind: 'field',
                field_key: 'images',
                media_target: 'public_url',
                transforms: ['extractUrls'],
              },
            },
            ...runtime,
          },
        },
        nodeDefinition: {
          input_ports: [
            {
              id: 'images',
              name: 'Images',
              data_type: 'image',
              field_key: 'images',
            },
          ],
        },
      });

      const result = runBuildScript(tempDir);
      assert.notEqual(result.status, 0, `${name}: 打包脚本应失败`);
      assert.match(result.stderr || result.stdout, expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

serialTest('build-model-asset-packages: payload 正式引用图像字段但节点未声明同名端口时应阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'bad-video-port-fixture',
      modelId: 'bad-video-port-fixture',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'imageInput',
              component: 'imageUpload',
              required: false,
              component_props: {
                accept: 'image/*',
              },
            },
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
            'body.image': {
              kind: 'field',
              field_key: 'imageInput',
            },
          },
        },
      },
      nodeDefinition: {
        input_ports: [],
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '缺少同名图像端口的坏包必须被阻断');
    assert.match(
      result.stderr || result.stdout,
      /node_definition\.payload_image_field_missing:imageInput/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 图像端口使用旧别名或多余字段时应阻断', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'veo-3.1-generate-preview',
      modelId: 'veo-3.1-generate-preview',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'imageReference',
              component: 'imageUpload',
              required: false,
              component_props: {
                accept: 'image/*',
              },
            },
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
            'body.image': {
              kind: 'field',
              field_key: 'imageReference',
            },
          },
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'imageReference',
            name: '参考图',
            data_type: 'image',
            field_key: 'imageReference',
          },
          {
            id: 'referenceImage',
            name: '旧参考图',
            data_type: 'image',
            field_key: 'referenceImage',
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.notEqual(result.status, 0, '多余旧别名图像端口的坏包必须被阻断');
    assert.match(
      result.stderr || result.stdout,
      /node_definition\.payload_image_field_extra:referenceImage/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

serialTest('build-model-asset-packages: 图像端口与正式 payload 完全一致时允许打包', () => {
  const tempDir = makeTempDir();

  try {
    writeSourcePackage(tempDir, {
      packageId: 'kling-v3-image2video',
      modelId: 'kling-v3-image2video',
      runtimeModel: {
        capability: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
          supports_async_task: false,
        },
        parameter_schema: {
          fields: [
            {
              field_key: 'firstFrame',
              component: 'imageUpload',
              required: false,
              component_props: {
                accept: 'image/*',
                maxFiles: 1,
              },
            },
            {
              field_key: 'endFrame',
              component: 'imageUpload',
              required: false,
              component_props: {
                accept: 'image/*',
                maxFiles: 1,
              },
            },
            {
              field_key: 'referenceImages',
              component: 'imageUpload',
              required: false,
              component_props: {
                accept: 'image/*',
                maxFiles: 4,
              },
            },
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
            'body.first_frame': {
              kind: 'field',
              field_key: 'firstFrame',
            },
            'body.end_frame': {
              kind: 'field',
              field_key: 'endFrame',
            },
            'body.references': {
              kind: 'field',
              field_key: 'referenceImages',
            },
          },
        },
      },
      nodeDefinition: {
        input_ports: [
          {
            id: 'firstFrame',
            name: '首帧',
            data_type: 'image',
            field_key: 'firstFrame',
          },
          {
            id: 'endFrame',
            name: '尾帧',
            data_type: 'image',
            field_key: 'endFrame',
          },
          {
            id: 'referenceImages',
            name: '参考图',
            data_type: 'image',
            field_key: 'referenceImages',
            multiple: true,
          },
        ],
      },
    });

    const result = runBuildScript(tempDir);
    assert.equal(result.status, 0, `字段完全一致的包应可通过: ${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

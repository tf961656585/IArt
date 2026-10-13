import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateJobsToTasks } from '../monitor/task-aggregator.cts';

type TaskAggregatorHardCutFixtureJob = {
  id?: string;
  taskId?: string;
  type?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  projectPath: string;
  execution?: {
    trace: {
      id: string;
      type: string;
      status: string;
      createdAt: number;
      updatedAt: number;
    }[];
  };
  metadata?: {
    taskId: string;
  };
};

void test('task-aggregator: 忽略 execution.trace 旧口径，只消费显式 job 列表', () => {
  const now = Date.now();
  const fixtureJobs: TaskAggregatorHardCutFixtureJob[] = [
    {
      taskId: 'legacy-task-1',
      projectPath: '/tmp/project',
      execution: {
        trace: [
          {
            id: 'legacy-job-1',
            type: 'http',
            status: 'succeeded',
            createdAt: now - 10,
            updatedAt: now,
          },
        ],
      },
    },
    {
      id: 'job-live-1',
      type: 'http',
      status: 'succeeded',
      createdAt: now - 5,
      updatedAt: now,
      projectPath: '/tmp/project',
      metadata: {
        taskId: 'task-live-1',
      },
    },
  ];

  const groups = aggregateJobsToTasks(fixtureJobs);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.taskId, 'task-live-1');
  assert.equal(groups[0]?.jobs.length, 1);
  assert.equal(groups[0]?.jobs[0]?.id, 'job-live-1');
});

/**
 * 角色预设相关类型定义
 */

/**
 * 角色数据（完整结构，存储在项目文件夹内）
 */
export interface Character {
  /** 角色唯一 ID */
  id: string;
  /** 角色名称（可修改） */
  name: string;
  /** 角色描述 */
  description: string;
  /** 角色图片 URL（本地 /files/...） */
  imageUrl: string;
  /** 图像 MIME 类型 */
  mimeType: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/**
 * 角色索引项（轻量级，用于列表展示）
 */
export interface CharacterIndexItem {
  /** 角色唯一 ID */
  id: string;
  /** 角色名称 */
  name: string;
  /** 角色描述 */
  description: string;
  /** 角色图片 URL（本地 /files/...） */
  imageUrl: string;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 创建角色时的输入数据
 */
export interface CharacterCreateInput {
  /** 角色名称 */
  name: string;
  /** 角色描述 */
  description: string;
  /** 图像数据（Blob） */
  imageData: Blob;
  /** 图像 MIME 类型 */
  mimeType: string;
}

/**
 * 更新角色时的输入数据（仅允许修改 name 和 description）
 */
export interface CharacterUpdateInput {
  /** 角色名称 */
  name: string | undefined;
  /** 角色描述 */
  description: string | undefined;
}

/**
 * Avatar 行最大显示数量
 */
export const MAX_AVATAR_DISPLAY_COUNT = 10;

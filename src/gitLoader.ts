import simpleGit, { SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import path from 'path';

export interface GitLoaderConfig {
  targetExtensions: string[];
  excludeDirs: string[];
  maxFileSize: number;
}

const DEFAULT_CONFIG: GitLoaderConfig = {
  targetExtensions: ['.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.md', '.txt', '.json'],
  excludeDirs: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next'],
  maxFileSize: 1024 * 1024 // 1MB
};

export class GitLoader {
  private git: SimpleGit;
  private config: GitLoaderConfig;

  constructor(config: Partial<GitLoaderConfig> = {}) {
    this.git = simpleGit();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async cloneOrUpdateRepo(repoUrl: string, localPath: string): Promise<void> {
    try {
      const exists = await fs.access(localPath).then(() => true).catch(() => false);
      
      if (exists) {
        const isGitRepo = await fs.access(path.join(localPath, '.git')).then(() => true).catch(() => false);
        
        if (isGitRepo) {
          console.log(`Updating repository at ${localPath}`);
          const git = simpleGit(localPath);
          await git.pull();
        } else {
          console.log(`Directory exists but is not a git repository. Removing and cloning fresh.`);
          await fs.rm(localPath, { recursive: true, force: true });
          await this.git.clone(repoUrl, localPath);
        }
      } else {
        console.log(`Cloning repository to ${localPath}`);
        await this.git.clone(repoUrl, localPath);
      }
    } catch (error) {
      throw new Error(`Failed to clone or update repository: ${error}`);
    }
  }

  async getTargetFiles(localPath: string, extensions?: string[]): Promise<string[]> {
    const targetExts = extensions || this.config.targetExtensions;
    const files: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          const shouldExclude = this.config.excludeDirs.some(excludeDir => 
            entry.name === excludeDir || fullPath.includes(excludeDir)
          );
          
          if (!shouldExclude) {
            await walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (targetExts.includes(ext)) {
            try {
              const stats = await fs.stat(fullPath);
              if (stats.size <= this.config.maxFileSize) {
                files.push(fullPath);
              }
            } catch (error) {
              console.warn(`Could not access file ${fullPath}: ${error}`);
            }
          }
        }
      }
    };

    await walkDir(localPath);
    return files;
  }

  async readFileContent(filePath: string): Promise<{ content: string; relativePath: string }> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const relativePath = path.relative(process.cwd(), filePath);
      return { content, relativePath };
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error}`);
    }
  }

  async* loadRepositoryStream(repoUrl: string, localPath: string): AsyncGenerator<{ filePath: string; content: string; relativePath: string }, void, unknown> {
    await this.cloneOrUpdateRepo(repoUrl, localPath);
    const files = await this.getTargetFiles(localPath);
    
    for (const filePath of files) {
      try {
        const { content, relativePath } = await this.readFileContent(filePath);
        yield { filePath, content, relativePath };
      } catch (error) {
        console.warn(`Skipping file ${filePath}: ${error}`);
      }
    }
  }

  async loadRepository(repoUrl: string, localPath: string): Promise<{ filePath: string; content: string; relativePath: string }[]> {
    const results = [];
    for await (const file of this.loadRepositoryStream(repoUrl, localPath)) {
      results.push(file);
    }
    return results;
  }
}
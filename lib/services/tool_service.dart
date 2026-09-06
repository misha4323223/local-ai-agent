import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'file_service.dart';
import 'git_service.dart';

class ToolService {
  final FileService _fileService = FileService();
  GitService? _gitService;
  String _githubToken = '';

  /// Set GitHub personal access token for authenticated git operations
  void setGithubToken(String token) {
    _githubToken = token;
  }

  /// Set working directory for git operations
  void setWorkingDirectory(String directory) {
    _gitService = GitService(workingDirectory: directory);
  }

  /// Get tool definitions for Ollama
  List<Map<String, dynamic>> getToolDefinitions() {
    return [
      {
        'type': 'function',
        'function': {
          'name': 'createFolder',
          'description': 'Create a new directory at the specified path',
          'parameters': {
            'type': 'object',
            'properties': {
              'path': {
                'type': 'string',
                'description': 'The path of the directory to create',
              },
            },
            'required': ['path'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'readFile',
          'description': 'Read the contents of a file',
          'parameters': {
            'type': 'object',
            'properties': {
              'path': {
                'type': 'string',
                'description': 'The path of the file to read',
              },
            },
            'required': ['path'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'writeFile',
          'description': 'Write content to a file',
          'parameters': {
            'type': 'object',
            'properties': {
              'path': {
                'type': 'string',
                'description': 'The path of the file to write',
              },
              'content': {
                'type': 'string',
                'description': 'The content to write to the file',
              },
            },
            'required': ['path', 'content'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'listDirectory',
          'description': 'List contents of a directory',
          'parameters': {
            'type': 'object',
            'properties': {
              'path': {
                'type': 'string',
                'description': 'The path of the directory to list',
              },
            },
            'required': ['path'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'gitClone',
          'description': 'Clone a git repository into the working directory. Private repositories are supported if a GitHub token is configured in settings.',
          'parameters': {
            'type': 'object',
            'properties': {
              'url': {
                'type': 'string',
                'description': 'The repository URL (https://github.com/user/repo.git)',
              },
              'directory': {
                'type': 'string',
                'description': 'Optional target directory name',
              },
            },
            'required': ['url'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'gitStatus',
          'description': 'Get the git status of the repository',
          'parameters': {
            'type': 'object',
            'properties': {},
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'gitCommit',
          'description': 'Stage all changes and create a git commit',
          'parameters': {
            'type': 'object',
            'properties': {
              'message': {
                'type': 'string',
                'description': 'The commit message',
              },
            },
            'required': ['message'],
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'gitPush',
          'description': 'Push commits to remote repository',
          'parameters': {
            'type': 'object',
            'properties': {
              'remote': {
                'type': 'string',
                'description': 'The remote name (default: origin)',
              },
              'branch': {
                'type': 'string',
                'description': 'The branch name (default: main)',
              },
            },
          },
        },
      },
      {
        'type': 'function',
        'function': {
          'name': 'gitPull',
          'description': 'Pull commits from remote repository',
          'parameters': {
            'type': 'object',
            'properties': {
              'remote': {
                'type': 'string',
                'description': 'The remote name (default: origin)',
              },
              'branch': {
                'type': 'string',
                'description': 'The branch name (default: main)',
              },
            },
          },
        },
      },
    ];
  }

  /// Execute a tool call
  Future<String> executeTool(String toolName, Map<String, dynamic> arguments) async {
    if (kIsWeb) {
      return '⚠️ Файловые операции и git недоступны в веб-версии. '
          'Запустите приложение на Windows или Android.';
    }
    switch (toolName) {
      case 'createFolder':
        return await _fileService.createFolder(arguments['path']);
      
      case 'readFile':
        return await _fileService.readFile(arguments['path']);
      
      case 'writeFile':
        return await _fileService.writeFile(arguments['path'], arguments['content']);
      
      case 'listDirectory':
        return await _fileService.listDirectory(arguments['path']);
      
      case 'gitClone':
        _gitService ??= GitService();
        final cloneUrl = arguments['url'] as String;
        if (_githubToken.isNotEmpty) {
          return await _gitService!.cloneWithToken(
              cloneUrl, _githubToken, arguments['directory']);
        }
        return await _gitService!.clone(cloneUrl, arguments['directory']);
      
      case 'gitStatus':
        _gitService ??= GitService();
        return await _gitService!.status();
      
      case 'gitCommit':
        _gitService ??= GitService();
        return await _gitService!.commit(arguments['message']);
      
      case 'gitPush':
        _gitService ??= GitService();
        final remote = arguments['remote'] ?? 'origin';
        final branch = arguments['branch'] ?? 'main';
        return await _gitService!.push(remote, branch);
      
      case 'gitPull':
        _gitService ??= GitService();
        final remote = arguments['remote'] ?? 'origin';
        final branch = arguments['branch'] ?? 'main';
        return await _gitService!.pull(remote, branch);
      
      default:
        return 'Unknown tool: $toolName';
    }
  }

  /// Parse tool calls from Ollama response
  List<Map<String, dynamic>> parseToolCalls(String response) {
    final List<Map<String, dynamic>> toolCalls = [];
    
    try {
      final data = jsonDecode(response);
      if (data['tool_calls'] != null) {
        for (final call in data['tool_calls']) {
          toolCalls.add({
            'name': call['function']['name'],
            'arguments': call['function']['arguments'],
          });
        }
      }
    } catch (e) {
      // Try to extract tool calls from text if not JSON
      // This is a fallback for models that don't support native tool calling
    }
    
    return toolCalls;
  }
}

import 'package:process_run/process_run.dart';

class GitService {
  String workingDirectory;

  GitService({this.workingDirectory = '.'});

  /// Execute a git command
  Future<String> _runCommand(String command, [List<String>? args]) async {
    try {
      final fullCommand = ['git', command, ...?args].join(' ');
      final results = await run(
        fullCommand,
        workingDirectory: workingDirectory,
      );
      
      if (results.isEmpty) {
        return 'No output';
      }
      
      final result = results.first;
      if (result.exitCode != 0) {
        return 'Git error: ${result.stderr}';
      }
      
      return result.stdout.toString().trim();
    } catch (e) {
      return 'Error running git: $e';
    }
  }

  /// Git status
  Future<String> status() async {
    return await _runCommand('status');
  }

  /// Git add all files
  Future<String> addAll() async {
    return await _runCommand('add', ['.']);
  }

  /// Git commit
  Future<String> commit(String message) async {
    // First add all
    await addAll();
    return await _runCommand('commit', ['-m', message]);
  }

  /// Git push
  Future<String> push([String remote = 'origin', String branch = 'main']) async {
    return await _runCommand('push', [remote, branch]);
  }

  /// Git pull
  Future<String> pull([String remote = 'origin', String branch = 'main']) async {
    return await _runCommand('pull', [remote, branch]);
  }

  /// Git log
  Future<String> log([int count = 10]) async {
    return await _runCommand('log', ['--oneline', '-n', count.toString()]);
  }

  /// Git branch list
  Future<String> branches() async {
    return await _runCommand('branch', ['-a']);
  }

  /// Git diff
  Future<String> diff() async {
    return await _runCommand('diff');
  }

  /// Initialize a new git repo
  Future<String> init() async {
    return await _runCommand('init');
  }

  /// Clone a repository
  Future<String> clone(String url, [String? directory]) async {
    final args = [url];
    if (directory != null) {
      args.add(directory);
    }
    return await _runCommand('clone', args);
  }

  /// Clone a repository authenticated with a GitHub personal access token
  Future<String> cloneWithToken(String url, String token,
      [String? directory]) async {
    final authUrl = url.startsWith('https://')
        ? url.replaceFirst('https://', 'https://x-access-token:$token@')
        : url;
    return await clone(authUrl, directory);
  }

  /// Check if current directory is a git repo
  Future<bool> isGitRepo() async {
    try {
      final results = await run(
        'git rev-parse --is-inside-work-tree',
        workingDirectory: workingDirectory,
      );
      return results.isNotEmpty && results.first.exitCode == 0;
    } catch (e) {
      return false;
    }
  }
}

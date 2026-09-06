import 'dart:io';
import 'package:path/path.dart' as p;

class FileService {
  /// Create a directory
  Future<String> createFolder(String path) async {
    try {
      final directory = Directory(path);
      if (await directory.exists()) {
        return 'Directory already exists: $path';
      }
      await directory.create(recursive: true);
      return 'Directory created: $path';
    } catch (e) {
      return 'Error creating directory: $e';
    }
  }

  /// Read file content
  Future<String> readFile(String path) async {
    try {
      final file = File(path);
      if (!await file.exists()) {
        return 'File not found: $path';
      }
      final content = await file.readAsString();
      return content;
    } catch (e) {
      return 'Error reading file: $e';
    }
  }

  /// Write content to file
  Future<String> writeFile(String path, String content) async {
    try {
      final file = File(path);
      await file.writeAsString(content);
      return 'File written: $path';
    } catch (e) {
      return 'Error writing file: $e';
    }
  }

  /// List directory contents
  Future<String> listDirectory(String path) async {
    try {
      final directory = Directory(path);
      if (!await directory.exists()) {
        return 'Directory not found: $path';
      }
      
      final contents = <String>[];
      await for (final entity in directory.list()) {
        final name = p.basename(entity.path);
        final type = entity is Directory ? '[DIR]' : '[FILE]';
        contents.add('$type $name');
      }
      
      if (contents.isEmpty) {
        return 'Directory is empty: $path';
      }
      return contents.join('\n');
    } catch (e) {
      return 'Error listing directory: $e';
    }
  }

  /// Check if path exists
  Future<bool> exists(String path) async {
    try {
      final type = FileSystemEntity.typeSync(path);
      return type != FileSystemEntityType.notFound;
    } catch (e) {
      return false;
    }
  }

  /// Delete file or directory
  Future<String> delete(String path) async {
    try {
      final entity = FileSystemEntity.typeSync(path) == FileSystemEntityType.directory
          ? Directory(path)
          : File(path);
      
      if (!await entity.exists()) {
        return 'Path not found: $path';
      }
      
      await entity.delete(recursive: true);
      return 'Deleted: $path';
    } catch (e) {
      return 'Error deleting: $e';
    }
  }

  /// Get current working directory
  String getCurrentDirectory() {
    return Directory.current.path;
  }

  /// Join path segments
  String joinPath(String part1, [String? part2, String? part3]) {
    if (part2 != null && part3 != null) {
      return p.join(part1, part2, part3);
    } else if (part2 != null) {
      return p.join(part1, part2);
    }
    return p.join(part1);
  }
}

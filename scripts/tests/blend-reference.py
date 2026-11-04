"""Read-only Blender oracle; never saves or changes the source .blend file."""
import bpy
import json
import sys

source, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=source, load_ui=False)
scene = bpy.context.scene
result = {'version': bpy.app.version_string, 'fps': scene.render.fps / scene.render.fps_base,
          'start': scene.frame_start, 'end': scene.frame_end, 'frames': {}, 'objects': {}}
for obj in scene.objects:
    if obj.type == 'MESH':
        mesh = obj.data
        mesh.calc_loop_triangles()
        result['objects']['OB' + obj.name] = {
            'vertices': [list(v.co) for v in mesh.vertices],
            'area': sum(t.area for t in mesh.loop_triangles),
            'modifiers': [m.type for m in obj.modifiers if m.show_viewport],
        }
span = scene.frame_end - scene.frame_start
for frame in [scene.frame_start, scene.frame_start + span * .25,
              scene.frame_start + span * .5, scene.frame_end]:
    integer = int(frame)
    scene.frame_set(integer, subframe=frame - integer)
    result['frames'][str(frame)] = {
        'OB' + obj.name: [list(row) for row in obj.matrix_world]
        for obj in scene.objects if obj.type == 'MESH'
    }
with open(output, 'w', encoding='utf-8') as stream:
    json.dump(result, stream)
print('Blender reference:', len(result['objects']), 'mesh objects;', bpy.app.version_string)

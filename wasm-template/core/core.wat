(module
 (type $0 (func (param i32 i32) (result i32)))
 (type $1 (func (param i32) (result i32)))
 (memory $0 0)
 (export "generateToken" (func $core/core/generateToken))
 (export "verifyToken" (func $core/core/verifyToken))
 (export "memory" (memory $0))
 (func $core/core/verifyToken (param $0 i32) (param $1 i32) (result i32)
  local.get $0
  i32.const -2128831035
  i32.xor
  i32.const 16777619
  i32.mul
  local.tee $0
  i32.const 15
  i32.shr_u
  local.get $0
  i32.xor
  i32.const -2048144777
  i32.mul
  local.tee $0
  local.get $0
  i32.const 13
  i32.shr_u
  i32.xor
  local.get $1
  i32.eq
 )
 (func $core/core/generateToken (param $0 i32) (result i32)
  local.get $0
  i32.const -2128831035
  i32.xor
  i32.const 16777619
  i32.mul
  local.tee $0
  i32.const 15
  i32.shr_u
  local.get $0
  i32.xor
  i32.const -2048144777
  i32.mul
  local.tee $0
  local.get $0
  i32.const 13
  i32.shr_u
  i32.xor
 )
)

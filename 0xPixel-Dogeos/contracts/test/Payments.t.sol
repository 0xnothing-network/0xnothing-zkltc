// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {DogeosPixel} from "../src/DogeosPixel.sol";
import {PixelMarket} from "../src/PixelMarket.sol";
interface PaymentVm {function deal(address,uint256) external;function prank(address) external;function expectRevert(bytes4) external;function warp(uint256) external;}
contract PayoutReceiver {
 PixelMarket market;bool public reentryBlocked;bool reject;
 constructor(PixelMarket m,bool rejects) {market=m;reject=rejects;}
 function bid() external payable {market.makeOffer{value:msg.value}(1,uint64(block.timestamp+1000));}
 function cancel(uint256 id) external {market.cancelOffer(id);}
 function withdraw(address payable to) external {market.withdraw(to);}
 receive() external payable {if(reject)revert();try market.withdraw(payable(address(this))){reentryBlocked=false;}catch{reentryBlocked=true;}}
}
contract PaymentsTest {
 PaymentVm constant vm=PaymentVm(address(uint160(uint256(keccak256('hevm cheat code')))));
 DogeosPixel nft;PixelMarket market;
 function setUp() public {vm.warp(100);nft=new DogeosPixel();market=new PixelMarket(nft,address(0xFEE));vm.prank(address(0xA11CE));nft.mintPacked('Doge','',8,hex'000000ff0000');vm.deal(address(this),10 ether);}
 function testWithdrawalCannotReenter() public {PayoutReceiver receiver=new PayoutReceiver(market,false);receiver.bid{value:1 ether}();receiver.cancel(1);receiver.withdraw(payable(address(receiver)));require(receiver.reentryBlocked()&&address(receiver).balance==1 ether&&market.credits(address(receiver))==0&&market.totalCredits()==0);}
 function testRejectedWithdrawalRetainsCreditAndCanChooseRecipient() public {PayoutReceiver receiver=new PayoutReceiver(market,true);receiver.bid{value:1 ether}();receiver.cancel(1);vm.expectRevert(PixelMarket.PaymentFailed.selector);receiver.withdraw(payable(address(receiver)));require(market.credits(address(receiver))==1 ether&&market.totalCredits()==1 ether);receiver.withdraw(payable(address(0xB0B)));require(market.credits(address(receiver))==0&&address(0xB0B).balance==1 ether);}
}
